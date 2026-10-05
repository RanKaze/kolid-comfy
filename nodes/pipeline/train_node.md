# TrainEditLoraNode

训练 Reference Latent LoRA 的节点，用于让模型学会利用参考图进行图像编辑。

## 概述

`TrainEditLoraNode` 是一个在 ComfyUI 中直接训练 LoRA 的节点，设计上参考了 ComfyUI 内置的 `TrainLoraNode`。训练数据通过节点图传入（latent + conditioning），无需外部数据文件或 JSON 配置。

该节点的核心目标是：训练一个轻量级 LoRA 适配器，使模型学会在推理时利用 `reference_latents`（参考图潜空间）进行图像编辑。支持 Krea2、Flux2Klein 两种架构。

## 工作原理

### 1. 数据准备

训练数据完全通过节点图传入：

```
目标图 → VAE Encode → latents（目标潜空间）
参考图 → VAE Encode → ReferenceLatentNode → reference
prompt → CLIP Text Encode → conditioning（正样本）
```

`positive`（conditioning）中已包含 `reference_latents`，节点无需额外处理参考图。

### 2. 架构 Model Patch

根据 `architecture` 参数选择对应的架构模块，对模型应用 patch：

| 架构 | Patch 方式 | 说明 |
|---|---|---|
| **Krea2** | index_timestep_zero patch | 将参考图 latent 作为额外 token 追加到注意力序列中，在 t=0 下条件化 |
| **Flux2Klein** | 无需 patch | 模型原生支持 reference_latents |

#### Krea2 架构图

Krea2 使用单流 DiT 架构，所有 token 在同一序列中处理：

```
┌─────────────────────────────────────────────────────────────────────┐
│                       Krea2 Single-Stream DiT                       │
│                                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ 文本     │  │ 图像     │  │ 参考     │  │ 参考     │          │
│  │ tokens   │  │ tokens   │  │ tokens 1 │  │ tokens 2 │          │
│  │ (Qwen3VL)│  │ (noisy)  │  │ (t=0)    │  │ (t=0)    │          │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘          │
│       │              │              │              │               │
│       └──────────┬───┴──────────────┴──────────────┘              │
│                  │                                                 │
│                  ▼                                                 │
│  ┌─────────────────────────────────────────────────────┐           │
│  │              Token 拼接 (Concat)                     │           │
│  │  [text_tokens | img_tokens | ref_tokens_1 | ref_2]  │           │
│  │                                                       │          │
│  │  分割点 split = txtlen + imglen - reflen             │          │
│  │  [:split] = text + noisy image (使用真实 t 的调制)   │          │
│  │  [split:] = reference tokens (使用 t=0 的调制)       │          │
│  └──────────────────────────┬──────────────────────────┘          │
│                             │                                       │
│                             ▼                                       │
│  ┌─────────────────────────────────────────────────────┐           │
│  │           SingleStreamBlock #1                       │           │
│  │  ┌─────────────────────────────────────────────┐    │           │
│  │  │  Prenorm → Self-Attention → Residual        │    │           │
│  │  │                    ↑                         │    │           │
│  │  │  调制: vec(t) 作用于 [:split]               │    │           │
│  │  │  调制: refvec(t=0) 作用于 [split:]          │    │           │
│  │  │                                               │    │           │
│  │  │  to_q, to_k, to_v  ◄── LoRA 注入点           │    │           │
│  │  └─────────────────────────────────────────────┘    │           │
│  │  ┌─────────────────────────────────────────────┐    │           │
│  │  │  Postnorm → MLP (SwiGLU) → Residual         │    │           │
│  │  │  同样使用双调制 (vec / refvec)               │    │           │
│  │  └─────────────────────────────────────────────┘    │           │
│  └─────────────────────────────────────────────────────┘           │
│                             │                                       │
│                             ▼                                       │
│  ┌─────────────────────────────────────────────────────┐           │
│  │           SingleStreamBlock #2 ... #N                │           │
│  │           (同上结构，每层都有 LoRA)                   │           │
│  └─────────────────────────────────────────────────────┘           │
│                             │                                       │
│                             ▼                                       │
│  ┌─────────────────────────────────────────────────────┐           │
│  │           Final Layer (last)                         │           │
│  │  调制: vec(t)                                         │           │
│  │  输出: 只取 [:split] 的 noisy image tokens           │           │
│  │  (参考 tokens 被丢弃，不影响输出维度)                 │           │
│  └─────────────────────────────────────────────────────┘           │
│                             │                                       │
│                             ▼                                       │
│                     noise prediction                                │
└─────────────────────────────────────────────────────────────────────┘

参考 token 的 RoPE 位置编码:
  ref_pos[i] = (i+1, y_grid, x_grid)
  — axis-0 使用递增索引区分不同参考图
  — axis-1/2 使用各自的 y/x 网格坐标

训练时:
  1. 参考图 latent → patchify → ref_tokens
  2. ref_tokens 追加到图像 token 序列末尾
  3. 通过双调制 (vec/refvec) 让参考 tokens 在 t=0 条件化
  4. LoRA 只训练 to_q/to_k/to_v，学习如何从参考 tokens 提取信息
```

#### Flux2Klein 架构图

Flux2Klein 基于双流 + 单流 DiT，reference_latents 由模型原生 extra_conds 机制处理：

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Flux2Klein DiT 架构                              │
│                                                                     │
│  ┌──────────┐                    ┌──────────┐                      │
│  │ 文本     │                    │ 图像     │                      │
│  │ tokens   │                    │ tokens   │                      │
│  │ (T5+CLIP)│                    │ (noisy)  │                      │
│  └────┬─────┘                    └────┬─────┘                      │
│       │                               │                            │
│       ▼                               ▼                            │
│  ┌─────────────────────────────────────────────────────┐           │
│  │         Double-Stream Blocks (×N)                    │           │
│  │  ┌──────────────┐      ┌──────────────┐             │           │
│  │  │  文本流       │      │  图像流       │             │           │
│  │  │  Self-Attn   │      │  Self-Attn   │             │           │
│  │  │  Cross-Attn  │◄────►│  Cross-Attn  │             │           │
│  │  │  MLP         │      │  MLP         │             │           │
│  │  │              │      │              │             │           │
│  │  │  to_q/k/v    │      │  to_q/k/v    │ ◄── LoRA    │           │
│  │  └──────────────┘      └──────────────┘             │           │
│  └─────────────────────────────────────────────────────┘           │
│                             │                                       │
│                             ▼                                       │
│  ┌─────────────────────────────────────────────────────┐           │
│  │         Token 拼接 → Single-Stream Blocks (×M)       │           │
│  │  [text_tokens | img_tokens]                          │           │
│  │                                                       │          │
│  │  ┌─────────────────────────────────────────────┐    │           │
│  │  │  Self-Attention (全序列)                     │    │           │
│  │  │  to_q, to_k, to_v  ◄── LoRA 注入点           │    │           │
│  │  │  MLP (并行)                                  │    │           │
│  │  └─────────────────────────────────────────────┘    │           │
│  └─────────────────────────────────────────────────────┘           │
│                             │                                       │
│                             ▼                                       │
│  ┌─────────────────────────────────────────────────────┐           │
│  │         Final Layer → noise prediction               │           │
│  └─────────────────────────────────────────────────────┘           │
│                                                                     │
│  Reference Latent 注入 (原生 extra_conds):                          │
│  ┌─────────────────────────────────────────────────────┐           │
│  │  参考图 → VAE Encode → reference_latents             │           │
│  │  → 通过 extra_conds 传入模型                          │           │
│  │  → 模型原生处理 (无需额外 patch)                      │           │
│  │                                                       │          │
│  │  训练时: reference_latents 直接附加到 conditioning    │          │
│  │  推理时: 同样方式附加，模型自动处理                   │          │
│  └─────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────┘
```

### 架构对比

| 特性 | Krea2 | Flux2Klein |
|---|---|---|
| 骨干网络 | Single-Stream DiT | Double + Single Stream DiT |
| Reference 注入方式 | Token 序列追加 (t=0) | 原生 extra_conds |
| 需要 Model Patch | ✅ (forward patch) | ❌ |
| Reference 尺寸限制 | 需 patchify 对齐 | 无 |
| LoRA 注入层 | to_q/k/v/out | to_q/k/v/out |
| 参考图作用机制 | 精确编辑 (强) | 原生支持 (强) |
| 是否需要训练 | 推荐（edit LoRA） | 可选 |

### 3. LoRA 注入

向模型的 self-attention 层注入低秩适配器（LoRA），只训练以下层：

- `to_q` / `to_k` / `to_v`（Q/K/V 投影）
- `to_out.0` / `to_out_0`（输出投影）
- `q` / `k` / `v` / `proj_attn`（其他命名约定）

每个目标 Linear 层被分解为：

```
W' = W + (alpha / rank) × B @ A

A: (rank, in_features)  — Kaiming 均匀初始化
B: (out_features, rank) — 零初始化（训练初期 W' = W）
```

只有 A 和 B 参与梯度更新，原始权重 W 被冻结。

### 4. 训练循环

```
for each step:
    1. 取 latent_samples[i] 作为目标图潜空间
    2. 随机采样时间步 t
    3. 生成噪声 noise，加到目标潜空间: noisy_latent = target + noise * 0.5
    4. 前向传播: noise_pred = model.predict_noise(noisy_latent, t, conditioning)
       — conditioning 中包含 reference_latents
       — patch 后的模型会自动处理参考信息
    5. 计算 loss = loss_fn(noise_pred, noise)
    6. loss / grad_accumulation_steps → backward
    7. 梯度累积达到步数后: clip_grad_norm → optimizer.step → scheduler.step
```

### 5. 保存

- 每 `save_every` 步保存一次检查点（`{output_name}_step{N}.safetensors`）
- 训练结束保存最终文件（`{output_name}.safetensors`）
- 输出目录：`{ComfyUI output}/loras/`
- 格式：safetensors，包含 `lora_A.weight`、`lora_B.weight`、`lora_scaling`

## 输入参数

| 参数 | 类型 | 默认值 | 范围 | 说明 |
|---|---|---|---|---|
| `model` | MODEL | — | — | 要训练 LoRA 的基础模型 |
| `latents` | LATENT | — | — | 目标图的潜空间，作为训练数据。支持 batch |
| `positive` | CONDITIONING | — | — | 正样本 conditioning，需已包含 reference_latents |
| `rank` | INT | 32 | 1-128 | LoRA 的秩，越大表达能力越强但更容易过拟合 |
| `alpha` | FLOAT | 16.0 | 0.1-512 | LoRA 缩放系数，实际缩放 = alpha / rank |
| `learning_rate` | FLOAT | 0.0005 | 1e-7 - 1.0 | 学习率，推荐 1e-4 ~ 5e-4 |
| `steps` | INT | 1000 | 1-100000 | 总训练步数 |
| `batch_size` | INT | 1 | 1-10000 | 每次前向传播的样本数，受显存限制 |
| `grad_accumulation_steps` | INT | 1 | 1-1024 | 梯度累积步数，等效 batch_size = batch_size × grad_accumulation_steps |
| `optimizer` | COMBO | AdamW | AdamW/Adam/SGD/RMSprop | 优化器类型 |
| `loss_function` | COMBO | MSE | MSE/L1/Huber/SmoothL1 | 损失函数 |
| `seed` | INT | 0 | 0-0xffffffffffffffff | 随机种子，用于 LoRA 权重初始化和噪声采样 |
| `training_dtype` | COMBO | bf16 | bf16/fp32/none | 训练精度。none 保留模型原生精度，fp16 模型会自动启用 GradScaler |
| `architecture` | COMBO | Krea2 | Krea2/Flux2Klein | 模型架构，决定 reference latent 的处理方式 |
| `output_name` | STRING | reference_lora | — | 输出的 LoRA 文件名（不含扩展名） |
| `save_every` | INT | 500 | 1-100000 | 每 N 步保存一次检查点 |

## 输出

| 输出 | 类型 | 说明 |
|---|---|---|
| `lora_path` | STRING | 训练完成的 LoRA 文件路径 |

## 推理使用

训练完成后，将 LoRA 加载到模型上，配合 `PipelineEnableEditNode` 启用 reference latents：

```
Load Checkpoint → model
                 ↓
PipelineEnableEditNode (enable=True, architecture=Krea2)
                 ↓
            PipelineNode → PipelineSamplerNode
                              ↑
ReferenceLatentNode ← 参考图 VAE Encode
```

## 推荐参数

### Krea2 (12GB 显存，需 fp8 量化)

| 参数 | 推荐值 |
|---|---|
| rank | 32 |
| alpha | 16 |
| learning_rate | 1e-4 |
| steps | 1750-5000 |
| batch_size | 1 |
| grad_accumulation_steps | 1 |
| training_dtype | bf16 |

### Flux2Klein

| 参数 | 推荐值 |
|---|---|
| rank | 32-64 |
| alpha | 16-32 |
| learning_rate | 1e-4 |
| steps | 3000-5000 |
| batch_size | 1 |
| grad_accumulation_steps | 2-4 |
| training_dtype | bf16 |

## 注意事项

1. **显存**：12GB 显存建议 `batch_size=1` + `grad_accumulation_steps=4` 等效 batch_size=4
2. **数据准备**：训练前先用 `VAEEncode` 将目标图和参考图编码为 latent，通过 `ReferenceLatentNode` 将参考 latent 附加到 conditioning
3. **验证**：建议先跑 500 步（约 15 分钟）确认 loss 在下降，再跑完整训练
4. **过拟合**：如果 loss 下降过快但生成质量变差，降低 rank 或减少 steps
5. **多架构**：不同架构的 model patch 逻辑在 `architecture/` 文件夹中，训练和推理使用相同的方式

## 参考资料

### 基础知识

#### 扩散模型 (Diffusion Model)

扩散模型通过"加噪 → 去噪"的过程生成图像。训练时模型学习预测噪声，推理时从纯噪声逐步去噪得到图像。核心公式：

```
前向过程（加噪）:  x_t = √(α_t) × x_0 + √(1-α_t) × ε      ε ~ N(0, I)
反向过程（去噪）:  ε_pred = model(x_t, t, conditioning)
损失函数:          L = MSE(ε_pred, ε)
```

- `x_0`：原始图像（或其 latent）
- `x_t`：在时间步 t 加噪后的 latent
- `t`：时间步，t=0 表示无噪声（清晰图），t 越大噪声越多
- `ε`：添加的高斯噪声
- `conditioning`：文本编码、参考图等条件信息

#### VAE (Variational Autoencoder)

VAE 将高分辨率像素图像压缩到低维潜空间，扩散模型在潜空间中运行以节省计算量。

```
像素图像 (H×W×3)  ──VAE Encode──►  Latent (H/8 × W/8 × 16)  [Krea2/Flux2Klein]
```

VAE 压缩率为 8 倍空间 + 16 通道。

#### LoRA (Low-Rank Adaptation)

LoRA 通过低秩矩阵分解来近似权重的更新量，只训练少量参数即可微调大模型。

```
原始权重:  W ∈ R^(d_out × d_in)        (冻结，不训练)
LoRA 更新: ΔW = (α/r) × B @ A
           A ∈ R^(r × d_in)            (可训练)
           B ∈ R^(d_out × r)           (可训练)
           r << min(d_in, d_out)       (秩，通常 8-128)
           α = scaling factor           (缩放系数)

最终输出:  W' = W + (α/r) × B @ A
```

**优势**：
- 训练参数量从 d×d 降低到 2×r×d（如 d=1024, r=32 时减少 94%）
- 原始权重不变，LoRA 可随时加载/卸载
- 多个 LoRA 可叠加（不同风格/概念）

**初始化策略**：
- A: Kaiming 均匀分布（打破对称性）
- B: 零矩阵（训练初期 ΔW=0，输出 = 原始模型）

#### Conditioning (条件信息)

Conditioning 是引导扩散模型生成的条件信息，通过 `conditioning_set_values` 附加到 conditioning 字典中。本项目支持的参考信息形式：

**1. reference_latents（参考潜空间）**

```
参考图 → VAE Encode → latent → 附加到 conditioning["reference_latents"]
```

- **作用**：将参考图的潜空间作为条件，让模型在生成时参考其内容
- **机制**：取决于架构（attention k/v 拼接、token 追加、原生 extra_conds）
- **特点**：不改变模型输入维度，通过 attention 机制软引导
- **适用**：风格迁移、身份保持、构图参考
- **训练**：可训练 LoRA 增强效果

**2. concat_latent（潜空间拼接）**

```
参考图 → VAE Encode → latent → 拼接到模型输入通道
```

- **作用**：将参考图 latent 直接拼接到噪声 latent 的通道维度上
- **机制**：模型输入通道拼接，模型直接看到参考图
- **特点**：控制力强，但要求参考图与目标图空间尺寸对齐
- **适用**：图像编辑、inpaint（需要 inpaint/edit 模型）
- **训练**：不需要额外训练，但需要特殊模型（inpaint 权重）

**3. ControlNet（控制网络）**

```
参考图 → 预处理器（Canny/Depth/Pose等）→ ControlNet → 附加到 conditioning["control"]
```

- **作用**：通过独立的小型网络注入结构化控制信号
- **机制**：ControlNet 在 UNet 的每层注入残差特征
- **特点**：精确控制构图/姿态/边缘，不影响风格
- **适用**：姿态控制、线稿上色、深度引导
- **训练**：需要单独训练 ControlNet 模型

**4. IPAdapter（图像提示适配器）**

```
参考图 → CLIP Vision → image embedding → 注入到 cross-attention
```

- **作用**：将参考图的语义特征注入到 cross-attention 的 k/v 中
- **机制**：通过额外的投影层将图像 embedding 转为 k/v
- **特点**：风格/内容混合，支持权重调节
- **适用**：风格迁移、角色一致性
- **训练**：需要训练 IPAdapter 权重

**5. Guidance（引导强度）**

```
conditioning["guidance"] = float_value
```

- **作用**：控制条件信息的引导强度（Flux 的 Guidance Distilled 模型）
- **机制**：作为标量条件输入模型的时间步嵌入
- **特点**：简单粗暴，单一标量控制整体引导强度
- **适用**：Flux Guidance Distilled 模型

### 参考信息形式对比

| 形式 | 机制 | 尺寸要求 | 控制力 | 需要训练 | 模型要求 |
|---|---|---|---|---|---|
| **reference_latents** | attention 注入 | 无 | 中（软引导） | 可选 LoRA | 取决于架构 |
| **concat_latent** | 通道拼接 | 必须对齐 | 强 | 不需要 | inpaint/edit 模型 |
| **ControlNet** | 残差特征注入 | 需对齐 | 强（结构） | 需训练 ControlNet | 对应架构 |
| **IPAdapter** | cross-attn k/v | 无 | 中（风格） | 需训练 IPAdapter | 对应架构 |
| **Guidance** | 标量条件 | 无 | 弱 | 不需要 | Guidance 模型 |

### reference_latents 在不同架构中的差异

| 架构 | 注入位置 | 条件化方式 | 尺寸限制 | 效果 |
|---|---|---|---|---|
| **Krea2** | token 序列追加 | t=0 双调制（vec/refvec） | 需 patchify 对齐 | 精确编辑，控制力强 |
| **Flux2Klein** | 原生 extra_conds | 模型原生处理 | 无 | 原生支持，效果稳定 |
