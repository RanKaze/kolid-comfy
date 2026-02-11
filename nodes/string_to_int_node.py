class StringToIntNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "", "multiline": False})
            }
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("number",)
    FUNCTION = "string_to_int"
    CATEGORY = "Kolid-Toolkit"

    def string_to_int(self, text: str):
        try:
            # 将字符串转换为整数
            number = int(text.strip())
            return (number,)
        except ValueError:
            # 如果转换失败，返回默认值 0 或抛出错误
            raise ValueError(f"无法将 '{text}' 转换为整数，请确保输入是有效的数字字符串")