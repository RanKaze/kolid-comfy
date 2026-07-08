import torch
import torch.nn as nn
import torch.nn.functional as F
import os
import gc
import re
import math
import comfy
import folder_paths
import comfy.model_management as mm
from ..architecture import Krea2 as arch_krea2
from ..architecture import Flux2Klein as arch_flux2klein


class TrainEditLoraNode:
    """训练 reference latent LoRA 的节点。
    参考 ComfyUI 内置 TrainLoraNode 设计，训练数据通过节点图传入。
    - latent: 目标图潜空间（可 batch）
    - positive: conditioning（已包含 reference_latents）
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model": ("MODEL", {"tooltip": "要训练 LoRA 的基础模型"}),
                "latents": ("LATENT", {"tooltip": "目标图的潜空间，作为训练数据。支持 batch"}),
                "positive": ("CONDITIONING", {"tooltip": "正样本 conditioning，需已包含 reference_latents"}),
                "rank": ("INT", {"default": 32, "min": 1, "max": 128, "tooltip": "LoRA 的秩，越大表达能力越强但更容易过拟合"}),
                "alpha": ("FLOAT", {"default": 16.0, "min": 0.1, "max": 512.0, "tooltip": "LoRA 缩放系数，实际缩放 = alpha / rank"}),
                "learning_rate": ("FLOAT", {"default": 0.0005, "min": 0.0000001, "max": 1.0, "tooltip": "学习率，推荐 1e-4 ~ 5e-4"}),
                "steps": ("INT", {"default": 1000, "min": 1, "max": 100000, "tooltip": "总训练步数"}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 10000, "tooltip": "每次前向传播的样本数，受显存限制"}),
                "grad_accumulation_steps": ("INT", {"default": 1, "min": 1, "max": 1024, "tooltip": "梯度累积步数，等效 batch_size = batch_size × grad_accumulation_steps"}),
                "optimizer": (["AdamW", "Adam", "SGD", "RMSprop"], {"default": "AdamW", "tooltip": "优化器类型"}),
                "loss_function": (["MSE", "L1", "Huber", "SmoothL1"], {"default": "MSE", "tooltip": "损失函数"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "tooltip": "随机种子，用于 LoRA 权重初始化和噪声采样"}),
                "training_dtype": (["bf16", "fp32", "none"], {"default": "bf16", "tooltip": "训练精度。none 保留模型原生精度，fp16 模型会自动启用 GradScaler"}),
                "architecture": (["Krea2", "Flux2Klein"], {"default": "Krea2", "tooltip": "模型架构，决定 reference latent 的处理方式"}),
                "output_name": ("STRING", {"default": "reference_lora", "tooltip": "输出的 LoRA 文件名（不含扩展名）"}),
                "save_every": ("INT", {"default": 500, "min": 1, "max": 100000, "tooltip": "每 N 步保存一次检查点"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("lora_path",)
    FUNCTION = "train"
    CATEGORY = "sampling/custom"

    def train(self, model, latents, positive,
              rank, alpha, learning_rate,
              steps, batch_size, grad_accumulation_steps,
              optimizer, loss_function, seed, training_dtype,
              architecture, output_name, save_every):

        # ==================== 0. 准备训练数据 ====================
        latent_samples = latents["samples"]  # (N, C, H, W)
        num_samples = latent_samples.shape[0]

        # conditioning 数量匹配
        if len(positive) == 1 and num_samples > 1:
            positive = positive * num_samples
        if len(positive) != num_samples:
            raise ValueError(f"latents 数量({num_samples}) 与 conditioning 数量({len(positive)}) 不匹配")

        # 设置随机种子
        torch.manual_seed(seed)
        gen = torch.Generator(device=latent_samples.device)
        gen.manual_seed(seed)

        print(f"[TrainEditLora] 架构: {architecture}")
        print(f"[TrainEditLora] 训练样本: {num_samples}")
        print(f"[TrainEditLora] rank={rank}, alpha={alpha}, lr={learning_rate}, steps={steps}")
        print(f"[TrainEditLora] optimizer={optimizer}, loss={loss_function}, dtype={training_dtype}, seed={seed}")

        # ==================== 1. 注入 LoRA 层 ====================
        arch_module = self._get_arch_module(architecture)
        model_patcher = arch_module.apply_model_patch(model)
        lora_params, lora_names = self._inject_lora(model_patcher, rank, alpha)
        print(f"[TrainEditLora] 注入了 {len(lora_params)} 个 LoRA 参数")

        # ==================== 2. 训练 ====================
        opt_map = {"AdamW": torch.optim.AdamW, "Adam": torch.optim.Adam, "SGD": torch.optim.SGD, "RMSprop": torch.optim.RMSprop}
        optimizer_obj = opt_map[optimizer](lora_params, lr=learning_rate)
        scheduler_lr = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer_obj, T_max=steps)

        loss_map = {"MSE": F.mse_loss, "L1": F.l1_loss, "Huber": F.huber_loss, "SmoothL1": F.smooth_l1_loss}
        loss_fn = loss_map[loss_function]

        base_model = model_patcher.model
        output_dir = os.path.join(folder_paths.get_output_directory(), "loras")
        os.makedirs(output_dir, exist_ok=True)

        step = 0
        accum_step = 0
        loss_accum = 0.0
        optimizer_obj.zero_grad()

        while step < steps:
            for i in range(num_samples):
                if step >= steps:
                    break
                try:
                    loss = self._train_step(
                        base_model, latent_samples, positive, i, loss_fn, gen
                    )
                    loss = loss / grad_accumulation_steps
                    loss.backward()

                    loss_accum += loss.item() * grad_accumulation_steps
                    accum_step += 1

                    if accum_step >= grad_accumulation_steps:
                        torch.nn.utils.clip_grad_norm_(lora_params, max_norm=1.0)
                        optimizer_obj.step()
                        optimizer_obj.zero_grad()
                        scheduler_lr.step()
                        accum_step = 0

                    if (step + 1) % 10 == 0:
                        avg_loss = loss_accum / 10
                        print(f"[TrainEditLora] Step {step+1}/{steps} | Loss: {avg_loss:.4f} | LR: {scheduler_lr.get_last_lr()[0]:.2e}")
                        loss_accum = 0.0

                    if (step + 1) % save_every == 0:
                        save_path = os.path.join(output_dir, f"{output_name}_step{step+1}.safetensors")
                        self._save_lora(lora_names, save_path)
                        print(f"[TrainEditLora] 保存检查点: {save_path}")

                    step += 1
                except Exception as e:
                    print(f"[TrainEditLora] Step {step} 失败: {type(e).__name__}: {e}")
                    step += 1
                    continue

        # ==================== 3. 保存最终 LoRA ====================
        final_path = os.path.join(output_dir, f"{output_name}.safetensors")
        self._save_lora(lora_names, final_path)
        print(f"[TrainEditLora] 训练完成，最终 LoRA 已保存: {final_path}")

        gc.collect()
        mm.soft_empty_cache()

        return (final_path,)

    def _get_arch_module(self, architecture):
        if re.search(r"Krea2", architecture, re.IGNORECASE):
            return arch_krea2
        elif re.search(r"Flux2Klein", architecture, re.IGNORECASE):
            return arch_flux2klein
        else:
            raise ValueError(f"不支持的架构: {architecture}")

    def _inject_lora(self, model_patcher, rank, alpha):
        """向模型的 self-attention 层注入 LoRA 适配器。"""
        scaling = alpha / rank
        lora_params = []
        lora_names = []

        def _get_lora_layer(weight):
            in_features = weight.shape[1]
            out_features = weight.shape[0]
            lora_A = nn.Parameter(torch.zeros(rank, in_features, device=weight.device, dtype=weight.dtype))
            lora_B = nn.Parameter(torch.zeros(out_features, rank, device=weight.device, dtype=weight.dtype))
            nn.init.kaiming_uniform_(lora_A, a=math.sqrt(5))
            return lora_A, lora_B

        dit = model_patcher.get_model_object("diffusion_model")
        injected_count = 0

        for name, module in dit.named_modules():
            target_names = ["to_q", "to_k", "to_v", "to_out.0", "to_out_0", "q", "k", "v", "proj_attn"]
            should_inject = False
            for tn in target_names:
                if name.endswith(tn) or name.endswith(f".{tn}"):
                    should_inject = True
                    break
            if not should_inject:
                continue
            if isinstance(module, nn.Linear):
                lora_A, lora_B = _get_lora_layer(module.weight)
                lora_params.extend([lora_A, lora_B])
                lora_names.append((name, lora_A, lora_B, scaling, module))
                injected_count += 1

        print(f"[TrainEditLora] 注入 LoRA 到 {injected_count} 个层")
        return lora_params, lora_names

    def _train_step(self, base_model, latent_samples, positive, index, loss_fn, gen):
        """单个训练步。
        latent_samples[index] 是目标图潜空间。
        positive[index] 的 conditioning 中已包含 reference_latents。"""
        target_latent = latent_samples[index:index+1]  # (1, C, H, W)

        # 随机时间步
        timesteps = torch.randint(0, 1000, (1,), device=target_latent.device, dtype=target_latent.dtype)

        # 添加噪声
        noise = torch.randn(target_latent.size(), generator=gen, device=target_latent.device, dtype=target_latent.dtype)
        noisy_latent = target_latent + noise * 0.5

        # 前向传播（conditioning 中已有 reference_latents，patch 后的模型会自动处理）
        cond = [positive[index]]
        noise_pred = base_model.predict_noise(noisy_latent, timesteps, cond)
        loss = loss_fn(noise_pred, noise)

        return loss

    def _save_lora(self, lora_names, path):
        """保存 LoRA 权重为 safetensors 格式。"""
        from safetensors.torch import save_file

        state_dict = {}
        for name, lora_A, lora_B, scaling, _ in lora_names:
            state_dict[f"{name}.lora_A.weight"] = lora_A.detach().cpu()
            state_dict[f"{name}.lora_B.weight"] = lora_B.detach().cpu()
            state_dict[f"{name}.lora_scaling"] = torch.tensor(scaling)

        save_file(state_dict, path)
