import re

class RegexMatcherNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "regex_pattern": ("STRING", {"default": r"\w+", "multiline": False}),
                "input_string": ("STRING", {"default": "", "multiline": False}),
            }
        }

    RETURN_TYPES = ("STRING[]", "BOOLEAN")
    RETURN_NAMES = ("matches", "has_matches")
    FUNCTION = "match_regex"
    CATEGORY = "Kolid-Toolkit"

    def match_regex(self, regex_pattern: str, input_string: str):
        try:
            # 编译正则表达式
            pattern = re.compile(regex_pattern)
            # 查找所有匹配项
            matches = pattern.findall(input_string)
            # 返回匹配的字符串列表和是否有匹配的布尔值
            has_matches = len(matches) > 0
            return (matches, has_matches)
        except re.error as e:
            # 如果正则表达式无效，返回空列表并记录错误
            print(f"Error: Invalid regex pattern - {str(e)}")
            return ([], False)