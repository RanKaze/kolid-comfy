# -*- coding: utf-8 -*-
"""
掩码表达式解析与求值（ImageDetectNode / VideoSegmentationNode 共用）。

表达式格式（如 "(body:0.2-face:0.2)&(human:0.1)"）：
  - 术语:  name / name:0.3 / name(0.3) / (name:0.3)，支持多词概念（如 "red car:0.4"）
  - 运算符（从左到右计算，无优先级，可用括号分组）:
      &  交集
      +  并集（| 为别名）
      -  差集
  - 函数（参数间逗号分隔，可嵌套）:
      max(a, b, ...)  逐像素取最大（多术语并集）
      min(a, b, ...)  逐像素取最小
      grow(x, n)      n>0 形态学膨胀（圆形结构元素向外扩 n 像素）,
                      n<0 形态学腐蚀（向内缩 |n| 像素）,
                      如 "grow(character:0.2, 5) - face:0.2"、"grow(body:0.2, -8)"
  - 未写阈值的术语使用 default_threshold（调用方传入）
  - 同一术语检测到多个实例时，调用方先取实例并集再喂给 eval_expression
"""
import torch


_SPECIAL_CHARS = "()&+|-:,"


class _Term:
    """叶子节点：术语（名称 + 置信度阈值）"""
    __slots__ = ("name", "threshold")

    def __init__(self, name, threshold):
        self.name = name
        self.threshold = threshold


class _Group:
    """括号分组节点"""
    __slots__ = ("inner",)

    def __init__(self, inner):
        self.inner = inner


class _BinOp:
    """二元运算节点：& / + / | / -"""
    __slots__ = ("op", "left", "right")

    def __init__(self, op, left, right):
        self.op = op
        self.left = left
        self.right = right


class _Func:
    """函数节点：max(...) / min(...)，args 为子表达式列表"""
    __slots__ = ("name", "args")

    def __init__(self, name, args):
        self.name = name
        self.args = args


class _Grow:
    """膨胀/腐蚀节点：grow(子表达式, 像素数)

    radius > 0 向外膨胀 radius 像素；radius < 0 向内腐蚀 |radius| 像素（缩小）。
    """
    __slots__ = ("inner", "radius")

    def __init__(self, inner, radius):
        self.inner = inner
        self.radius = radius


def _tokenize(text):
    """切分为 ('special', 字符) 与 ('atom', 原文) 两类 token。

    atom 允许包含空格（多词概念），边界仅由特殊字符决定。
    """
    tokens = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in _SPECIAL_CHARS:
            tokens.append(("special", c))
            i += 1
        else:
            j = i
            while j < n and text[j] not in _SPECIAL_CHARS:
                j += 1
            raw = text[i:j]
            # 丢弃纯空白片段（运算符周围、行首尾的空白），
            # 保留 atom 内部的空白（多词概念）
            if raw.strip():
                tokens.append(("atom", raw))
            i = j
    return tokens


def _parse_threshold(raw):
    s = raw.strip()
    try:
        t = float(s)
    except (TypeError, ValueError):
        raise ValueError(
            f"掩码表达式中的阈值 '{s}' 无效，应为 [0, 1] 内的数字。"
        )
    if not (0.0 <= t <= 1.0):
        raise ValueError(f"阈值必须在 [0, 1] 内，当前为 {t}。")
    return t


class _Parser:
    """递归下降解析器：expr := primary (OP primary)*"""

    def __init__(self, tokens, default_threshold):
        self.tokens = tokens
        self.pos = 0
        self.default_threshold = default_threshold

    def _peek(self, k=0):
        idx = self.pos + k
        if idx < len(self.tokens):
            return self.tokens[idx]
        return (None, None)

    def _next(self):
        tok = self._peek()
        self.pos += 1
        return tok

    def parse(self):
        if not self.tokens:
            raise ValueError("掩码表达式为空。")
        node = self._parse_expr()
        if self.pos != len(self.tokens):
            kind, val = self._peek()
            raise ValueError(f"掩码表达式在第 {self.pos} 个 token '{val}' 处存在多余内容。")
        return node

    def _parse_expr(self):
        node = self._parse_primary()
        while True:
            kind, val = self._peek()
            if kind == "special" and val in ("&", "+", "-", "|"):
                self._next()
                right = self._parse_primary()
                node = _BinOp(val, node, right)
            else:
                return node

    def _parse_primary(self):
        kind, val = self._peek()
        if kind is None:
            raise ValueError("掩码表达式意外结束。")

        if kind == "special":
            if val == "(":
                self._next()
                node = self._parse_expr()
                kind, val = self._peek()
                if not (kind == "special" and val == ")"):
                    raise ValueError("掩码表达式中缺少 ')'。")
                self._next()
                return _Group(node)
            raise ValueError(f"掩码表达式中出现意外的 '{val}'，此处应为术语名或 '('。")

        # atom：术语名（可带阈值）或函数名
        self._next()
        name = val.strip()
        if not name:
            raise ValueError("掩码表达式中的术语名为空。")
        threshold = self.default_threshold

        kind2, val2 = self._peek()

        # 函数调用：max(...) / min(...) / grow(...)。函数名后跟 '(' 一律按函数解析
        # （后缀阈值形式 name(0.3) 要求括号内是单个数字，与之不冲突）
        if name in ("max", "min") and kind2 == "special" and val2 == "(":
            return self._parse_func(name)
        if name == "grow" and kind2 == "special" and val2 == "(":
            return self._parse_grow()

        if kind2 == "special" and val2 == ":":
            # name:0.3 形式
            self._next()
            kind3, val3 = self._peek()
            if kind3 != "atom":
                raise ValueError(f"术语 '{name}' 之后的 ':' 后缺少阈值数值。")
            self._next()
            threshold = _parse_threshold(val3)
        elif kind2 == "special" and val2 == "(":
            # name(0.3) 后缀阈值形式：需要向前看两步（数字 + ')'）
            kind3, val3 = self._peek(1)
            kind4, val4 = self._peek(2)
            if kind3 == "atom" and kind4 == "special" and val4 == ")":
                self._next()
                self._next()
                self._next()
                threshold = _parse_threshold(val3)

        return _Term(name, threshold)

    def _parse_func(self, fname):
        self._next()  # consume '('
        args = [self._parse_expr()]
        while True:
            kind, val = self._peek()
            if kind == "special" and val == ",":
                self._next()
                args.append(self._parse_expr())
            elif kind == "special" and val == ")":
                self._next()
                return _Func(fname, args)
            else:
                raise ValueError(f"函数 '{fname}' 的参数列表格式错误（应为 ',' 或 ')'）。")

    def _parse_grow(self):
        """grow(子表达式, 像素数)：第二个参数是字面数字（可为负，负值即缩小）。"""
        self._next()  # consume '('
        inner = self._parse_expr()
        kind, val = self._peek()
        if not (kind == "special" and val == ","):
            raise ValueError("函数 'grow' 需要两个参数: grow(表达式, 像素数)。")
        self._next()
        # 负数会被 tokenizer 拆成 '-' + 数字两个 token，这里先吃掉可选负号
        sign = ""
        kind, val = self._peek()
        if kind == "special" and val == "-":
            self._next()
            sign = "-"
            kind, val = self._peek()
        if kind != "atom":
            raise ValueError("函数 'grow' 的第二个参数应为像素数（数字）。")
        self._next()
        s = sign + val.strip()
        try:
            radius = float(s)
        except (TypeError, ValueError):
            raise ValueError(f"函数 'grow' 的像素数 '{s}' 无效，应为 [-500, 500] 内的数字。")
        if not (-500.0 <= radius <= 500.0):
            raise ValueError(f"函数 'grow' 的像素数应在 [-500, 500] 内，当前为 {s}。")
        kind, val = self._peek()
        if not (kind == "special" and val == ")"):
            raise ValueError("函数 'grow' 的参数列表格式错误（应为 ',' 或 ')'）。")
        self._next()
        return _Grow(inner, radius)


def parse_mask_expression(text, default_threshold=0.2):
    """将掩码表达式字符串解析为 AST。

    示例："(skin:0.2)&(head:0.3)-eye(0.1)+(nose:0.1)"、
          "max(body:0.2,skin:0.2)&(human:0.1)"
    """
    if text is None:
        raise ValueError("掩码表达式为 None。")
    return _Parser(_tokenize(text), default_threshold).parse()


def collect_terms(node, out=None):
    """收集 AST 中去重后的 (name, threshold) 术语列表（保持顺序）。"""
    if out is None:
        out = []
    if isinstance(node, _Term):
        key = (node.name, node.threshold)
        if key not in out:
            out.append(key)
    elif isinstance(node, _Group):
        collect_terms(node.inner, out)
    elif isinstance(node, _BinOp):
        collect_terms(node.left, out)
        collect_terms(node.right, out)
    elif isinstance(node, _Func):
        for arg in node.args:
            collect_terms(arg, out)
    elif isinstance(node, _Grow):
        collect_terms(node.inner, out)
    else:
        raise TypeError(f"未知的 AST 节点类型: {type(node)}")
    return out


def _grow_mask(mask, radius):
    """圆形结构元素的膨胀（radius > 0）/腐蚀（radius < 0）。

    基于 scipy 距离变换（EDT），比方形 max-pool 更符合"扩/缩 n 像素"直觉：
    膨胀 = 距前景像素欧氏距离 <= r，腐蚀 = 距背景像素欧氏距离 > |r|，两者严格对称。
    腐蚀时先把 mask 向四周 padding True（等效于画面外的掩码仍是前景），
    与 OpenCV erode / scipy grey_erosion 的默认边界一致 —— 否则贴边的掩码
    会被画面边框"咬"掉一圈。
    mask 为 CPU float 张量 [H, W]。
    """
    if radius == 0:
        return mask * 1.0
    import numpy as np
    from scipy.ndimage import distance_transform_edt

    fg = mask >= 0.5
    if not bool(fg.any()):
        return torch.zeros_like(mask)

    if radius > 0:
        dist = distance_transform_edt(~fg.numpy())
        return torch.from_numpy(dist <= float(radius)).to(mask.dtype)

    r = float(-radius)
    pad = int(np.ceil(r))
    padded = np.pad(fg.numpy(), pad, mode="constant", constant_values=True)
    dist = distance_transform_edt(padded)
    h, w = fg.shape
    return torch.from_numpy(dist[pad:pad + h, pad:pad + w] > r).to(mask.dtype)


def eval_expression(node, term_masks):
    """基于每术语的 [H, W] float 掩码（0/1）对 AST 求值。

    运算符：& 交集、+ / | 并集、- 差集；函数：max / min 逐像素取最值。
    """
    if isinstance(node, _Term):
        key = (node.name, node.threshold)
        if key not in term_masks:
            raise KeyError(f"术语 '{node.name}:{node.threshold}' 未检测。")
        return term_masks[key]
    if isinstance(node, _Group):
        return eval_expression(node.inner, term_masks)
    if isinstance(node, _BinOp):
        left = eval_expression(node.left, term_masks)
        right = eval_expression(node.right, term_masks)
        if node.op == "&":
            return left * right
        if node.op in ("+", "|"):
            return torch.clamp(left + right, max=1.0)
        if node.op == "-":
            return left * (1.0 - right)
        raise ValueError(f"未知运算符 '{node.op}'。")
    if isinstance(node, _Func):
        if not node.args:
            raise ValueError(f"函数 '{node.name}' 至少需要一个参数。")
        stacked = torch.stack(
            [eval_expression(arg, term_masks) for arg in node.args], dim=0
        )
        if node.name == "max":
            return stacked.amax(dim=0)
        if node.name == "min":
            return stacked.amin(dim=0)
        raise ValueError(f"未知函数 '{node.name}'。")
    if isinstance(node, _Grow):
        inner = eval_expression(node.inner, term_masks)
        return _grow_mask(inner, node.radius)
    raise TypeError(f"未知的 AST 节点类型: {type(node)}")
