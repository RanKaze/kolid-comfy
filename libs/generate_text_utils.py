"""Generate Text 复写工具 —— 对齐 ComfyUI 的 TextGenerate / "Generate Text" 节点。

pipeline 侧的语义：把「指令 prompt」和「原始 positive」拼起来交给一个文本生成
CLIP（Gemma / Qwen 等 LLM 编码器）生成一段新文本，拿回来当新的 positive 提示词。

调用策略是「优先复用 ComfyUI 原生节点，失败回退底层 CLIP 三件套」：
原生类走 comfy_extras.nodes_textgen.TextGenerate，保证与 ComfyUI 面板上的
Generate Text 节点行为 100% 一致（模板、thinking、stop token、mtp 全部对齐）。
一旦 import 或调用失败（不同 ComfyUI 版本的 mtp / 签名差异），回退到直接调用
clip.tokenize / clip.generate / clip.decode，参数逐项降级，尽量不中断采样。
"""

import inspect

# ComfyUI TextGenerate 的 mtp 取值：auto / off / 2..5
MTP_CHOICES = ("auto", "off", "2", "3", "4", "5")

# sampling_mode 面板上的取值
SAMPLING_MODES = ("on", "off")

# 与 ComfyUI TextGenerate 保持一致的默认值（0.37.0 的 schema）
DEFAULT_GENERATE_TEXT_PARAMS = {
    "max_length": 512,
    "sampling_mode": "on",
    "temperature": 0.7,
    "top_k": 64,
    "top_p": 0.95,
    "min_p": 0.05,
    "repetition_penalty": 1.05,
    "presence_penalty": 0.0,
    "seed": 0,
    "thinking": False,
    "use_default_template": True,
    "mtp": "auto",
}


def normalize_mtp(mtp):
    """把面板值转成 clip.generate 的 mtp 实参（对齐 ComfyUI execute 的转换）。"""
    if mtp is None:
        return True
    if isinstance(mtp, bool):
        return mtp
    s = str(mtp).strip().lower()
    if s in ("off", "false", "0", "disable", "disabled"):
        return False
    if s in ("auto", "true", "1", "enable", "enabled", ""):
        return True
    try:
        return int(s)
    except (TypeError, ValueError):
        return True


def build_sampling_mode(params):
    """构造 ComfyUI DynamicCombo 期望的 sampling_mode 字典。

    TextGenerate.execute 里读的是 sampling_mode.get('sampling_mode') 以及各采样
    参数；我们把面板上的独立控件重新打包成同一个结构，这样能和原生节点共用
    执行体，参数语义不会漂移。
    """
    mode = str(params.get("sampling_mode", "on") or "on").strip().lower()
    if mode not in SAMPLING_MODES:
        mode = "on" if mode in ("true", "1", "enable", "enabled", "yes") else "off"

    out = {"sampling_mode": mode}
    if mode == "on":
        out["temperature"] = float(params.get("temperature", 0.7))
        out["top_k"] = int(params.get("top_k", 64))
        out["top_p"] = float(params.get("top_p", 0.95))
        out["min_p"] = float(params.get("min_p", 0.05))
        out["repetition_penalty"] = float(params.get("repetition_penalty", 1.05))
        out["presence_penalty"] = float(params.get("presence_penalty", 0.0))
        out["seed"] = int(params.get("seed", 0) or 0)
    return out


def combine_prompt(instruction, positive):
    """指令 prompt 在前、原始 positive 在后，空行分隔（用户选定的拼接格式）。"""
    instruction = (instruction or "").strip()
    positive = (positive or "").strip()
    if not instruction:
        return positive
    if not positive:
        return instruction
    return f"{instruction}\n\n{positive}"


def normalize_ref_image(image):
    """把 ref image 规整成 ComfyUI 的 IMAGE 批次 [B,H,W,C]；不可用返回 None。

    Enable Edit 时会把 Context Ref 选中的那张图送进 Generate Text（多模态 CLIP
    能「看着图」改写提示词）。这里只做最小归一：tensor 原样透传（ComfyUI IMAGE
    本来就是 [B,H,W,C]），numpy 转 tensor，其余一律 None —— 绝不抛异常，
    因为调用方是 fail-open 的采样链路。
    """
    if image is None:
        return None
    try:
        import torch
    except Exception:
        return None
    try:
        if isinstance(image, dict):
            # 防御：万一传进来的是 LATENT 这类 dict，取 samples 再判断
            image = image.get("samples", image)
        if isinstance(image, torch.Tensor):
            t = image
        else:
            t = torch.as_tensor(image)
        if t.dim() == 3:
            t = t.unsqueeze(0)          # [H,W,C] → [1,H,W,C]
        elif t.dim() == 2:
            t = t.unsqueeze(0).unsqueeze(-1)   # [H,W] → [1,H,W,1]
        if t.dim() != 4:
            return None
        if not t.is_floating_point():
            t = t.float()
        return t
    except Exception:
        return None


def _resolve_textgen_class():
    """拿到 ComfyUI 的 TextGenerate 类；拿不到返回 None。"""
    try:
        from comfy_extras.nodes_textgen import TextGenerate
        return TextGenerate
    except Exception:
        return None


def _output_to_text(out):
    """io.NodeOutput 取字符串；已展开的 tuple / 裸字符串也兼容。"""
    if out is None:
        return None
    # io.NodeOutput 保存位置参数在 .args
    args = getattr(out, "args", None)
    if args:
        first = args[0]
        return first if isinstance(first, str) else (None if first is None else str(first))
    if isinstance(out, str):
        return out
    if isinstance(out, (tuple, list)) and out:
        first = out[0]
        return first if isinstance(first, str) else (None if first is None else str(first))
    return None


def _call_native_textgen(textgen_cls, clip, text, params):
    """调用 ComfyUI 原生 TextGenerate.execute。

    用 inspect.signature 过滤出当前 ComfyUI 版本真正支持的参数，这样 mtp 这种
    「新版才加」的输入在旧版上会被自动忽略而不是直接 TypeError。
    """
    kwargs = {
        "clip": clip,
        "prompt": text,
        "max_length": int(params.get("max_length", 512)),
        "sampling_mode": build_sampling_mode(params),
        "thinking": bool(params.get("thinking", False)),
        "use_default_template": bool(params.get("use_default_template", True)),
        "mtp": params.get("mtp", "auto"),
    }
    try:
        sig = inspect.signature(textgen_cls.execute)
        accepted = set(sig.parameters.keys())
    except (TypeError, ValueError):
        accepted = set(kwargs.keys())

    call_kwargs = {k: v for k, v in kwargs.items() if k in accepted}
    # execute 是 classmethod，直接挂在类上，无需实例化
    return textgen_cls.execute(**call_kwargs)


def _call_fallback(clip, text, params):
    """回退路径：直接调用 clip 的 tokenize / generate / decode。

    不同 ComfyUI 版本 generate 的签名不同（mtp 是后加的），所以逐个参数尝试
    降级：先带 mtp，再去掉 mtp，最后只保留最核心的几个参数。
    """
    mtp = normalize_mtp(params.get("mtp", "auto"))
    sampling = build_sampling_mode(params)
    do_sample = sampling.get("sampling_mode") == "on"

    tokenize_kwargs = {
        "skip_template": not bool(params.get("use_default_template", True)),
        "min_length": 1,
        "thinking": bool(params.get("thinking", False)),
    }
    try:
        sig = inspect.signature(clip.tokenize)
        tok_accepted = set(sig.parameters.keys())
    except (TypeError, ValueError):
        tok_accepted = set(tokenize_kwargs.keys())
    tokens = clip.tokenize(
        text, **{k: v for k, v in tokenize_kwargs.items() if k in tok_accepted}
    )

    full = dict(
        do_sample=do_sample,
        max_length=int(params.get("max_length", 512)),
        temperature=float(sampling.get("temperature", 0.7)),
        top_k=int(sampling.get("top_k", 64)),
        top_p=float(sampling.get("top_p", 0.95)),
        min_p=float(sampling.get("min_p", 0.05)),
        repetition_penalty=float(sampling.get("repetition_penalty", 1.05)),
        presence_penalty=float(sampling.get("presence_penalty", 0.0)),
        seed=sampling.get("seed"),
        mtp=mtp,
    )
    try:
        sig = inspect.signature(clip.generate)
        gen_accepted = set(sig.parameters.keys())
    except (TypeError, ValueError):
        gen_accepted = set(full.keys())

    generated_ids = clip.generate(
        tokens, **{k: v for k, v in full.items() if k in gen_accepted}
    )
    return clip.decode(generated_ids)


def run_generate_text(clip, text, params=None):
    """把 text 交给 Generate Text 生成新文本，返回生成的字符串。

    失败时抛异常，由调用方决定 fail-open（保留原 prompt）还是 fail-closed。
    """
    if clip is None:
        raise ValueError("Generate Text 需要 clip，但 pipeline.clip 为空")
    if not text or not str(text).strip():
        raise ValueError("Generate Text 的输入文本为空")

    merged = dict(DEFAULT_GENERATE_TEXT_PARAMS)
    if params:
        merged.update({k: v for k, v in params.items() if v is not None})

    textgen_cls = _resolve_textgen_class()
    if textgen_cls is not None:
        try:
            out = _call_native_textgen(textgen_cls, clip, text, merged)
            text_out = _output_to_text(out)
            if text_out is not None and str(text_out).strip():
                return str(text_out)
            # 原生路径返回空 → 再试回退，别把空串当结果
        except Exception as e:
            print(f"[GenerateText] Native TextGenerate failed ({type(e).__name__}: {e}) — falling back to raw CLIP calls")

    text_out = _call_fallback(clip, text, merged)
    if text_out is None or not str(text_out).strip():
        raise ValueError("Generate Text 生成了空文本")
    return str(text_out)


def apply_generate_text_to_prompt(pipeline, positive, prompt_text, params=None, label=""):
    """pipeline 侧的注入点：启用时用生成结果「完全替换」positive。

    返回 (new_positive, used)。未启用 / 无 clip / 无指令 prompt 时原样返回
    positive 且 used=False，保证 enable=False 的行为与不加该节点完全一致。
    """
    if pipeline is None or not isinstance(getattr(pipeline, "config", None), dict):
        return positive, False
    if not pipeline.config.get("enable_generate_text"):
        return positive, False

    instruction = (prompt_text or "").strip()
    if not instruction:
        print(f"[GenerateText]{label} enabled but instruction prompt is empty — passthrough")
        return positive, False

    clip = pipeline.config.get("generate_text_clip") or pipeline.clip
    if clip is None:
        print(f"[GenerateText]{label} enabled but no clip available — passthrough")
        return positive, False

    merged = dict(pipeline.config.get("generate_text") or {})
    if params:
        merged.update(params)

    combined = combine_prompt(instruction, positive)
    print(f"[GenerateText]{label} input ({len(combined)} chars): '{combined[:200]}'")
    generated = run_generate_text(clip, combined, merged)
    print(f"[GenerateText]{label} output ({len(generated)} chars): '{generated[:200]}'")
    # 完全替换：旧 positive 不再参与（用户明确要求）
    return generated, True
