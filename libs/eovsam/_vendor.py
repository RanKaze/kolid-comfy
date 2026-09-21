# -*- coding: utf-8 -*-
"""
Vendor 脚本：将 %TEMP%\EOVSAM-analysis 中的 sam3 / RADIO / maft 片段拷贝到本目录，
并完成包名重写（sam3 -> libs.eovsam.eovsam_sam3）与依赖补丁。

运行: python libs/eovsam/_vendor.py
可重复执行（幂等）。
"""
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(os.environ.get("TEMP", ""), "EOVSAM-analysis")


def copy_tree(src, dst):
    if os.path.exists(dst):
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns(
        "__pycache__", "*.pyc", ".git", "*.gif", "*.mp4", "*.tiff"))


def rewrite_sam3_imports(root):
    """把 sam3 绝对导入改写为 libs.eovsam.eovsam_sam3"""
    pat_from = re.compile(r"^(\s*)from sam3(\.|\s+import)", re.M)
    pat_import = re.compile(r"^(\s*)import sam3$", re.M)
    n = 0
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in filenames:
            if not fn.endswith(".py"):
                continue
            p = os.path.join(dirpath, fn)
            with open(p, "r", encoding="utf-8", errors="surrogateescape") as f:
                src = f.read()
            new = pat_from.sub(r"\1from libs.eovsam.eovsam_sam3\2", src)
            new = pat_import.sub(r"\1import libs.eovsam.eovsam_sam3", new)
            if new != src:
                with open(p, "w", encoding="utf-8", errors="surrogateescape") as f:
                    f.write(new)
                n += 1
    print(f"rewrote imports in {n} files")


def patch_files(root):
    P = lambda *a: os.path.join(root, *a)

    # ---- model_builder.py: 去掉 iopath / pkg_resources / huggingface_hub 依赖 ----
    p = P("model_builder.py")
    s = open(p, encoding="utf-8").read()
    s = s.replace("import pkg_resources\n", "")
    s = s.replace("from huggingface_hub import hf_hub_download\n", "")
    s = s.replace("from iopath.common.file_io import g_pathmgr\n", "")
    s = s.replace("with g_pathmgr.open(checkpoint_path, \"rb\") as f:", "with open(checkpoint_path, \"rb\") as f:")
    s = s.replace("with g_pathmgr.open(checkpoint_path, \"rb\") as f:", "with open(checkpoint_path, \"rb\") as f:")
    # 去掉 HF 下载函数
    s = re.sub(r"def download_ckpt_from_hf\(\):.*?return checkpoint_path\n", "", s, flags=re.S)
    s = s.replace("    if load_from_HF and checkpoint_path is None:\n        checkpoint_path = download_ckpt_from_hf()\n", "")
    # bpe 默认路径: 指向 vendored assets
    s = s.replace(
        'bpe_path = pkg_resources.resource_filename(\n            "sam3", "assets/bpe_simple_vocab_16e6.txt.gz"\n        )',
        'bpe_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "bpe_simple_vocab_16e6.txt.gz")'
    )
    open(p, "w", encoding="utf-8").write(s)

    # ---- tokenizer_ve.py: iopath -> open ----
    p = P("model", "tokenizer_ve.py")
    s = open(p, encoding="utf-8").read()
    s = s.replace("from iopath.common.file_io import g_pathmgr\n", "")
    s = s.replace("with g_pathmgr.open(bpe_path, \"rb\") as fh:", "with open(bpe_path, \"rb\") as fh:")
    open(p, "w", encoding="utf-8").write(s)

    # ---- model/edt.py: triton 可选 ----
    p = P("model", "edt.py")
    s = open(p, encoding="utf-8").read()
    if "HAS_TRITON" not in s:
        s = s.replace(
            "import torch\nimport triton\nimport triton.language as tl\n",
            "import torch\n\ntry:\n    import triton\n    import triton.language as tl\n    HAS_TRITON = True\nexcept ImportError:\n    HAS_TRITON = False\n"
        )
        open(p, "w", encoding="utf-8").write(s)

    # ---- content_dependent_transfer.py: maft position encoding -> vendored ----
    p = P("model", "content_dependent_transfer.py")
    s = open(p, encoding="utf-8").read()
    s = s.replace(
        "from maft.modeling.transformer_decoder.position_encoding import PositionEmbeddingSine",
        "from libs.eovsam.maft_position_encoding import PositionEmbeddingSine",
    )
    open(p, "w", encoding="utf-8").write(s)

    # ---- io_utils.py: cv2 延迟导入（保持原样即可，cv2 在 ComfyUI 中可用）----
    print("patches applied")


def main():
    if not os.path.isdir(SRC):
        print(f"source not found: {SRC}")
        sys.exit(1)

    # 1) sam3 -> eovsam_sam3（完整树，避免漏依赖）
    copy_tree(os.path.join(SRC, "sam3"), os.path.join(HERE, "eovsam_sam3"))
    rewrite_sam3_imports(os.path.join(HERE, "eovsam_sam3"))
    patch_files(os.path.join(HERE, "eovsam_sam3"))

    # 2) RADIO radio 包（内部相对导入，无需重写）
    copy_tree(os.path.join(SRC, "NVlabs", "RADIO", "radio"), os.path.join(HERE, "radio"))

    # 3) maft position_encoding
    shutil.copyfile(
        os.path.join(SRC, "maft", "modeling", "transformer_decoder", "position_encoding.py"),
        os.path.join(HERE, "maft_position_encoding.py"),
    )

    print("vendor done ->", HERE)


if __name__ == "__main__":
    main()
