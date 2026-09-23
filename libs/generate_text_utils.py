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


# 编码器里会导致「视觉模板被绕过」的前缀（comfy/text_encoders/qwen3vl.py:167）：
#     skip_template = skip_template or text.startswith('<|im_start|>')
# 一旦文本以它开头，视觉模板（连带 <|image_pad|>）就**不会**生成，图被彻底丢弃。
_CHAT_TEMPLATE_MARKERS = (
    "<|im_start|>",
    "<start_of_turn>",      # Gemma
    "<|begin_of_text|>",    # Llama
    "[INST]",               # Llama 2
)


def text_defeats_vision_template(text):
    """该文本会不会让编码器跳过视觉模板（从而让图失效）？

    这是 qwen3vl.py:167 那条 `text.startswith('<|im_start|>')` 的显式化。**只在
    真的会命中的时候**才是 True —— 编码器用的是严格 `startswith`，所以文本中间出现
    模板标记是无害的，不要误报。
    """
    if not isinstance(text, str):
        return False
    return text.startswith(_CHAT_TEMPLATE_MARKERS)


def strip_leading_chat_template(text):
    """剥掉文本开头的 chat 模板包裹，返回 (新文本, 是否被剥过)。

    为什么需要它（★ 本项目的核心坑）：`PipelineEnableEdit` 开着时，positive 往往是
    项目自己用 Qwen/Krea2 模板拼好的串，**以 `<|im_start|>system\\n…` 开头**（见
    `architecture/QwenEdit.py` 的 LLAMA_TEMPLATE、`architecture/Krea2.py` 的 template）。
    把这种串原样交给 Generate Text，编码器会走 `skip_template=True` 分支 → 不产生
    `<|image_pad|>` → 图**静默失效**。

    而用户单独用 ComfyUI 原生 Generate Text 节点时输入的是纯文本，不会触发这条，
    所以「原生节点能正常看图，pipeline 里不行」—— 差别就在这里，不是 image= 的形态问题。

    处理策略：把外层模板剥掉，只留下「system 指令 + user 正文」，再当作**纯文本**
    交给编码器；这样编码器会用 default 模板（带视觉槽）重新包裹它，图就能生效。
    """
    if not isinstance(text, str) or not text:
        return text, False
    if not text_defeats_vision_template(text):
        return text, False

    s = text
    stripped = False
    # 依次吃掉 leading 的 <|im_start|>role\n…<|im_end|>\n 块（system / user）。
    # 保留 system 块的内容作为前导说明文字，并保留最后一个非模板块的内容。
    import re as _re
    blocks = _re.findall(
        r"<\|im_start\|>(system|user|assistant)\n?(.*?)<\|im_end\|>", s, _re.S)
    if blocks:
        kept = []
        for role, body in blocks:
            body = body.strip()
            if not body:
                continue
            if role == "assistant":
                # assistant 块通常是空的占位（等模型续写），内容无意义
                continue
            kept.append(body)
        # 模板标记之后可能还有裸文本（模板没闭合的情况）
        tail = _re.sub(r"<\|im_start\|>\w*\n?", "", s, flags=_re.S)
        tail = _re.sub(r"<\|im_end\|>", "", tail)
        tail = _re.sub(r"<\|vision_start\|>|<\|vision_end\|>|<\|image_pad\|>", "", tail)
        for b in blocks:
            tail = tail.replace(b[1], "", 1)
        tail = tail.strip()
        if tail:
            kept.append(tail)
        if kept:
            s = "\n\n".join(kept)
            stripped = True
    if not stripped:
        # 兜底：只把标记本身删掉，至少不再以 <|im_start|> 开头
        s = s.replace("<|im_start|>", "").replace("<|im_end|>", "")
        s = _re.sub(r"^\s*(system|user|assistant)\s*\n", "", s)
        s = s.strip()
        stripped = s != text
    return s, stripped


def normalize_ref_image(image):
    """把单张图规整成 ComfyUI 的 IMAGE [B,H,W,C]；不可用返回 None。

    这里只做最小归一：tensor 原样透传（ComfyUI IMAGE 本来就是 [B,H,W,C]），
    numpy 转 tensor，其余一律 None —— 绝不抛异常，因为调用方是 fail-open 的采样链路。
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
        if t.shape[-1] == 4:
            # RGBA → 白底合成 RGB：vision 塔只吃 3 通道（对齐
            # architecture/QwenImage21.py 的处理），带 alpha 直送会编码出坏特征
            alpha = t[..., 3:4]
            t = t[..., :3] * alpha + (1.0 - alpha)
        return t
    except Exception:
        return None


def normalize_ref_images(images, single=False):
    """把多张图规整成 ComfyUI 编码器期望的形态；无可用图返回 None。

    语义（用户确认）：Enable Edit 时第一张 = `pipeline.image`（链上传递的图），
    之后**能传几张传几张** —— Ref Image 作为第二张。尺寸不一致时**跳过**放不进去的
    那张（不 resize、不报错），保证主图始终能送出去。

    返回形态（★ 对齐 ComfyUI 原生节点）：
      · `single=True`（默认给 `CLIP.tokenize` 用）→ **list of [1,H,W,C]**
        ComfyUI 原生所有「把图交给文本编码器」的节点都是这个约定：
            nodes_qwen.py:43,47      images = [image[:, :, :, :3]]; tokenize(prompt, images=images)
            nodes_joyimage.py:54,55  resized_images = [_resize_reference(i) for i in images]
            nodes_minimax_h3.py:143-156  images.append(img); tokenize(prompt, images=images)
            nodes_boogu.py:66,78     images_vl.append(s.movedim(1,-1)[:,:,:,:3])
        而 qwen3vl 的 `image=` 单数入口只是在内部做
            images = [image[i:i+1] for i in range(image.shape[0])]
        —— 把它拆成同一份 list。所以**list 形态与 batch 形态在编码器里完全等价**，
        但 list 是原生的规范形态，我们统一走它。

      · `single=False`（给 ComfyUI 原生 `TextGenerate.execute` 用）→ `[B,H,W,C]`
        原生 Generate Text 的 `image` 输入就是单张 IMAGE 批次，内部原样透传。

    返回 (payload, kept_labels) —— kept_labels 用于日志/调试展示。
    """
    if images is None:
        return None, []
    if not isinstance(images, (list, tuple)):
        images = [images]
    try:
        import torch
    except Exception:
        return None, []

    parts, labels = [], []
    ref_shape = None
    for idx, item in enumerate(images):
        t = normalize_ref_image(item)
        if t is None:
            continue
        if ref_shape is None:
            ref_shape = tuple(t.shape[1:])
        elif tuple(t.shape[1:]) != ref_shape:
            # 尺寸与首图不一致 → 跳过（绝不 resize，避免改变语义）
            print(f"[GenerateText] image #{idx + 1} skipped: shape {list(t.shape)} "
                  f"does not match {list(ref_shape)}")
            continue
        parts.append(t)
        labels.append(f"#{len(parts)} {tuple(t.shape)}")
    if not parts:
        return None, []

    if single:
        # ★ 原生约定：list of [1,H,W,C]。批次维 >1 时逐张切片，编码器按「多图」处理。
        flat = []
        for t in parts:
            if t.shape[0] <= 1:
                flat.append(t)
            else:
                flat.extend(t[i:i + 1] for i in range(t.shape[0]))
        return flat, labels

    try:
        batch = parts[0] if len(parts) == 1 else torch.cat(parts, dim=0)
    except Exception:
        return parts[0], labels[:1]
    return batch, labels


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


def _tokens_contain_image_embedding(tokens):
    """检查 tokenize 结果里是否真的塞进了图像 embedding。

    ComfyUI 的多模态编码器把 <|image_pad|> 位置替换成
    `{'type': 'image', 'data': <tensor>}` 这样的 dict 元素。如果图被送了但
    模板/`skip_template` 把它绕过了，token 流里就**找不到任何 image 元素** ——
    这正是「传了 image 却完全没影响生成」的静默失败。
    返回 (found: bool, count: int)。

    ★ 结构（comfy/text_encoders/qwen3vl.py）：
        tokens[key] = [ batch, ... ]        ← 外层列表，元素是 batch
        batch       = [ token_entry, ... ]  ← 单个 batch 的 token 序列
        token_entry = [ (elem, weight), (elem, weight), ... ]  逐帧/逐段权重列表
    所以必须**三层**下探到底，只扫两层就会 100% 漏判（这个诊断会变成永远说
    「图没生效」的假报警）。

    ★★ 另一个假报警源：QwenImage21Tokenizer 会在 tokens dict 里塞**标量**开关
    `out["keep_vision"] = True/False`（comfy/text_encoders/qwen_image21.py:27）。
    标量不可迭代 —— 若把每个 value 都当 token 流去 for，会在这里抛 TypeError 被
    吞掉，函数对 QwenImage21 clip **永远**返回 (False, 0)，于是运行时把图静默
    降级成纯文本（用户实测「原生节点能用图、pipeline 里永远 MISSING」的根因）。
    所以只有 list/tuple 形态的 value 才是 token 流，其余一律跳过。
    """
    found = 0
    try:
        streams = tokens.values() if isinstance(tokens, dict) else [tokens]
        for stream in streams:
            if not isinstance(stream, (list, tuple)):
                continue
            for batch in stream:
                for entry in batch:
                    for item in (entry if isinstance(entry, (list, tuple)) else [entry]):
                        elem = (item[0] if isinstance(item, (tuple, list)) and item
                                else item)
                        if isinstance(elem, dict) and \
                                elem.get("type") in ("image", "video") and \
                                elem.get("data") is not None:
                            found += 1
    except Exception:
        return False, 0
    return found > 0, found


def _warn_if_image_dropped(clip, tokens, image, label=""):
    """图送了却没变成 embedding → 明确告警（不抛，保持 fail-open）。

    踩过的坑：`use_default_template=False` 会让 TextGenerate 传 `skip_template=True`，
    编码器于是**直接吐原始文本、根本不套模板**，模板里的 `<|image_pad|>` 不存在，
    图就被彻底忽略 —— 表面上「成功传入」，实际零影响。
    """
    if image is None:
        return False
    found, count = _tokens_contain_image_embedding(tokens)
    if found:
        print(f"[GenerateText]{label} image embeddings in tokens: {count}")
        return True
    print(f"[GenerateText]{label} WARNING: image was passed but produced NO image "
          f"embedding — it will NOT affect the output. Likely causes: "
          f"(1) use_default_template=False makes skip_template=True so the vision "
          f"template (and its <|image_pad|>) is bypassed; "
          f"(2) the text encoder is not multimodal. "
          f"Set use_default_template=True and use a vision-capable text encoder.")
    return False


def _call_native_textgen(textgen_cls, clip, text, params, image=None, images=None):
    """调用 ComfyUI 原生 TextGenerate.execute（对齐 nodes_textgen.py:49-56）。

    用 inspect.signature 过滤出当前 ComfyUI 版本真正支持的参数，这样 mtp 这种
    「新版才加」的输入在旧版上会被自动忽略而不是直接 TypeError。

    图有两个入口，和原生节点一样：
      · `image`  单张 IMAGE 批次 [B,H,W,C] —— 原生 Generate Text 就是吃这个，
                 内部 `clip.tokenize(prompt, image=image, ...)` 原样透传。
      · `images` list of [1,H,W,C] —— 多图时走这里。原生 Generate Text **没有**
                 images 形参，所以我们把它拼回 [B,H,W,C] 再喂 `image`，
                 结果与原生 `TextGenerate(image=cat(...))` 逐位一致。
    版本不支持 image 时会被 signature 过滤掉 —— 此时调用方按「回退纯文本」处理。
    """
    if images is not None and image is None:
        try:
            import torch
            image = torch.cat(list(images), dim=0) if len(images) > 1 else images[0]
        except Exception:
            image = None
    kwargs = {
        "clip": clip,
        "prompt": text,
        "max_length": int(params.get("max_length", 512)),
        "sampling_mode": build_sampling_mode(params),
        "thinking": bool(params.get("thinking", False)),
        "use_default_template": bool(params.get("use_default_template", True)),
        "mtp": params.get("mtp", "auto"),
    }
    if image is not None:
        kwargs["image"] = image
    try:
        sig = inspect.signature(textgen_cls.execute)
        accepted = set(sig.parameters.keys())
    except (TypeError, ValueError):
        accepted = None

    call_kwargs = kwargs if accepted is None else {k: v for k, v in kwargs.items() if k in accepted}
    # 该版本的 execute 完全不接受 image → 明确回退纯文本（不能让 image 静默丢失后
    # 又以为「图已经送进去了」）。
    if image is not None and accepted is not None and "image" not in accepted:
        raise ValueError("this ComfyUI TextGenerate has no image input")
    # execute 是 classmethod，直接挂在类上，无需实例化
    return textgen_cls.execute(**call_kwargs)


def _call_fallback(clip, text, params, image=None, image_verified=None):
    """回退路径：直接调用 clip 的 tokenize / generate / decode。

    不同 ComfyUI 版本 generate 的签名不同（mtp 是后加的），所以逐个参数尝试
    降级：先带 mtp，再去掉 mtp，最后只保留最核心的几个参数。

    ★ 有图时**优先走 `images=`（list of [1,H,W,C]）**，这是 ComfyUI 原生
    「把图交给文本编码器」的规范入口（nodes_qwen / nodes_joyimage /
    nodes_minimax_h3 / nodes_boogu 全部这么做）；`image=` 单数只有原生
    Generate Text 一个用户。两者最终都在 qwen3vl 里汇成同一份 images list，
    但走 `images=` 不依赖 `image=` 这个较新的关键字，兼容面更宽。
    先试 `images=`，失败再退 `image=`，都不行才判定「这个 clip 不支持图像」。

    image_verified：调用方（run_generate_text）已经实测过的「图是否变成 embedding」
    结论。True → 跳过重复探测；False → 直接抛错走降级链；None → 这里自己探。
    """
    mtp = normalize_mtp(params.get("mtp", "auto"))
    sampling = build_sampling_mode(params)
    do_sample = sampling.get("sampling_mode") == "on"

    if image is not None and image_verified is False:
        # 上游已实测「图送不进去」→ 别再 tokenize 一次，直接抛错让上层丢图重试。
        raise ValueError("image was passed but produced no image embedding (pre-verified)")

    tokenize_kwargs = {
        "skip_template": not bool(params.get("use_default_template", True)),
        "min_length": 1,
        "thinking": bool(params.get("thinking", False)),
    }
    try:
        sig = inspect.signature(clip.tokenize)
        tok_params = sig.parameters
        tok_accepted = set(tok_params.keys())
    except (TypeError, ValueError):
        tok_params = {}
        tok_accepted = set(tokenize_kwargs.keys())

    img_list = None
    if image is not None:
        # ★ CLIP.tokenize 的签名是 (text, return_word_ids=False, **kwargs)：多模态
        #   关键字全部藏在 **kwargs 里。所以「参数名里没有 images」**不能**当成
        #   「不支持图像」—— 只有明确不带 VAR_KEYWORD 且两个名字都没有时才判不支持。
        supports_var_kw = any(p.kind == inspect.Parameter.VAR_KEYWORD
                              for p in tok_params.values())
        if "images" in tok_accepted or supports_var_kw:
            img_list, _ = normalize_ref_images(image, single=True)
        if img_list is None and "image" not in tok_accepted and not supports_var_kw:
            raise ValueError("this CLIP tokenize() has no image input")

    def _do_tokenize(with_img):
        kw = dict(tokenize_kwargs)
        if with_img is not None:
            kw["images"] = with_img          # 原生规范入口（list of [1,H,W,C]）
        return clip.tokenize(
            text, **{k: v for k, v in kw.items()
                     if k in tok_accepted or k in ("images",)}
        )

    if img_list is not None:
        tokens = _do_tokenize(img_list)
    elif image is not None:
        # 退路：该版本只认 image= 单数（如原生 Generate Text 的透传对象）
        tokens = clip.tokenize(
            text, **{k: v for k, v in {**tokenize_kwargs, "image": image}.items()
                     if k in tok_accepted or k in ("image",)}
        )
    else:
        tokens = _do_tokenize(None)

    # ★ 真正验证「图有没有变成 embedding」—— 这是唯一能证明图像生效的检查。
    #   skip_template=True（= use_default_template 关）会让编码器绕过视觉模板，
    #   图会被彻底忽略；此时给出明确警告而不是假装成功。
    #   ★ 判定条件只认 `image is not None`（重试纯文本那次 image 已经是 None，
    #     天然跳过），等价于「只有真的送了图才可能因为图没生效而失败」。
    if image is not None and not _warn_if_image_dropped(clip, tokens, image):
        # 图送了却没有 embedding = 100% 白送。**明确抛错**，让 run_generate_text
        # 走「丢图重试纯文本」的降级链 —— 绝不能让「传了图但图没生效」被当成成功，
        # 那正是用户反馈「感觉 image 没影响 text generate」的根源。
        raise ValueError("image was passed but produced no image embedding "
                         "(vision template bypassed or encoder is text-only)")

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


def run_generate_text(clip, text, params=None, image=None, images=None):
    """把 text 交给 Generate Text 生成新文本，返回生成的字符串。

    image  单张参考图；images 多张参考图列表（优先）。两者都为空 = 纯文本。
    有图时走多模态 tokenize，让文本编码器「看着图」改写提示词。

    失败时抛异常，由调用方决定 fail-open（保留原 prompt）还是 fail-closed。
    """
    if clip is None:
        raise ValueError("Generate Text 需要 clip，但 pipeline.clip 为空")
    if not text or not str(text).strip():
        raise ValueError("Generate Text 的输入文本为空")

    merged = dict(DEFAULT_GENERATE_TEXT_PARAMS)
    if params:
        merged.update({k: v for k, v in params.items() if v is not None})

    candidates = images if images is not None else image
    batch, kept = normalize_ref_images(candidates)
    img_list = None
    image_effective = None      # None = 未确认；True/False = 已实测
    if batch is not None:
        # ★ 与 ComfyUI 原生一致：交给编码器的是 **list of [1,H,W,C]**（`images=`），
        #   不是我们自己的批次堆叠。两者在 qwen3vl 里等价，但 list 是原生规范形态。
        img_list, _ = normalize_ref_images(candidates, single=True)
        print(f"[GenerateText] images attached: {kept} → "
              f"{len(img_list) if img_list else 0} image(s) as list")
        # ★ 前置告警：use_default_template=False 时 TextGenerate 会传 skip_template=True，
        #   编码器绕过视觉模板 → 图**必然**被忽略。提前说清，别等用户去猜。
        if not bool(merged.get("use_default_template", True)):
            print("[GenerateText] WARNING: use_default_template=False — the vision template "
                  "(and its <|image_pad|>) is skipped, so the image(s) will NOT affect the "
                  "result. Set use_default_template=True to let the image take effect.")
        # ★★ 有图时，文本**绝不能**以 chat 模板标记开头，否则编码器 qwen3vl.py:167 的
        #   `skip_template = skip_template or text.startswith('<|im_start|>')` 会直接把
        #   视觉模板绕掉 → 图静默失效。项目里 Enable Edit 开着时 positive 往往正是
        #   `<|im_start|>system\n…` 开头的模板串（architecture/QwenEdit.py、Krea2.py），
        #   于是「原生节点能用图、pipeline 里不行」。这里先把外层模板剥掉再送。
        if text_defeats_vision_template(text):
            _tidied, _was = strip_leading_chat_template(text)
            if _was and _tidied.strip():
                print("[GenerateText] text carried a leading chat template "
                      "(<|im_start|>…) which would BYPASS the vision template and drop the "
                      "image(s). Stripped it before tokenizing so the image can take effect.")
                text = _tidied
        # ★★ 关键实测：不依赖 TextGenerate 走哪条分支，**直接拿这个 clip 跑一次
        #   tokenize**，数 token 流里有没有 image embedding。有 → 图确实参与了
        #   （use_default_template=True，视觉模板与 <|image_pad|> 都在）；
        #   没有 → 图 100% 白送，必须走降级链而不是假装成功。
        #   这是唯一能区分「图真的生效」和「图看起来传进去了」的判据。
        #   ★ 探针用 `images=`（原生规范入口）并**必须把 text 放第一个位置参数** ——
        #     曾经在这里把 batch 当成 text 传进去，探针永远数不到 image embedding，
        #     于是 Debug 里常年报「图不会生效」。
        try:
            probe_tokens = clip.tokenize(
                text,
                images=img_list,
                skip_template=not bool(merged.get("use_default_template", True)),
                min_length=1,
                thinking=bool(merged.get("thinking", False)))
            _found, _cnt = _tokens_contain_image_embedding(probe_tokens)
            image_effective = _found
            if _found:
                print(f"[GenerateText] image embedding CONFIRMED: {_cnt} embedded "
                      f"(the image WILL affect the result)")
            else:
                print("[GenerateText] ★ image embedding MISSING — the image will NOT affect "
                      "the result. Falling back to text-only so nothing false is reported.")
        except Exception as e:
            # 探测本身失败不影响主流程（不同版本 tokenize 可能不接受这些 kwargs）
            print(f"[GenerateText] image-effectiveness probe skipped ({type(e).__name__}: {e})")

    textgen_cls = _resolve_textgen_class()
    if textgen_cls is not None and image_effective is not False:
        try:
            # ★ 原生 Generate Text 的 image 形参是**单张 IMAGE 批次**，所以这里给 batch
            #   （= 原生 image=cat(...)）。多图经 _call_native_textgen 内部拼回批次。
            out = _call_native_textgen(textgen_cls, clip, text, merged,
                                       images=img_list)
            text_out = _output_to_text(out)
            if text_out is not None and str(text_out).strip():
                return str(text_out)
            # 原生路径返回空 → 再试回退，别把空串当结果
        except Exception as e:
            print(f"[GenerateText] Native TextGenerate failed ({type(e).__name__}: {e}) — falling back to raw CLIP calls")

    # 回退路径：带图失败（CLIP 非多模态 / tokenize 不收图像 / 图没变成 embedding）
    # 时丢掉图重试纯文本，保证「传图不成立」不会演变成「Generate Text 整体失效」。
    try:
        text_out = _call_fallback(clip, text, merged, image=batch,
                                  image_verified=image_effective)
    except Exception as e:
        if batch is None:
            raise
        print(f"[GenerateText] images rejected ({type(e).__name__}: {e}) — retrying text-only")
        text_out = _call_fallback(clip, text, merged, image=None)
    if text_out is None or not str(text_out).strip():
        raise ValueError("Generate Text 生成了空文本")
    return str(text_out)


def describe_image_support(clip, use_default_template=True):
    """诊断「这个 clip 能不能让图像真正生效」，供 Debug / 日志说明原因。

    返回 (ok: bool, reason: str)。纯探测，不抛异常。
    """
    if clip is None:
        return False, "no clip"
    if not use_default_template:
        return False, ("use_default_template=False → skip_template=True → 视觉模板"
                       "（含 <|image_pad|>）被绕过，图不会生效")
    try:
        tok = getattr(clip, "tokenizer", None)
        enc = getattr(clip, "cond_stage_model", None)
        name = ""
        for obj in (tok, enc, clip):
            n = getattr(obj, "clip_name", None) or getattr(obj, "name", None)
            if isinstance(n, str) and n:
                name = n
                break
        if name:
            return True, f"clip={name}（需为多模态编码器才会真正看图）"
        return True, "clip 未暴露名称；若为纯文本编码器则图不生效"
    except Exception as e:
        return True, f"probe failed: {e}"


def apply_generate_text_to_prompt(pipeline, positive, prompt_text, params=None,
                                  label="", image=None, images=None):
    """pipeline 侧的注入点：启用时用生成结果「完全替换」positive。

    image / images 是可选参考图（Enable Edit 时的 pipeline.image + Ref Image）。
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

    candidates = images if images is not None else image
    batch, kept = normalize_ref_images(candidates)
    if candidates is not None and batch is None:
        print(f"[GenerateText]{label} images unusable — text-only")
    elif batch is not None:
        print(f"[GenerateText]{label} using images {kept} (multimodal tokenize)")
        ok, reason = describe_image_support(
            clip, bool(merged.get("use_default_template", True)))
        if not ok:
            print(f"[GenerateText]{label} WARNING: image(s) will NOT take effect — {reason}")

    combined = combine_prompt(instruction, positive)
    print(f"[GenerateText]{label} input ({len(combined)} chars): '{combined[:200]}'")
    generated = run_generate_text(clip, combined, merged, image=batch)
    print(f"[GenerateText]{label} output ({len(generated)} chars): '{generated[:200]}'")
    # 完全替换：旧 positive 不再参与（用户明确要求）
    return generated, True
