from ..libs.utils import AlwaysEqualProxy

any_type = AlwaysEqualProxy("*")

class ScriptNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "script": ("STRING", {"default": "", "multiline": True}),
            },
            "optional": {
                "x": (any_type),
                "y": (any_type),
                "z": (any_type),
            }
        }

    INPUT_IS_LIST = True
    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("*",)
    FUNCTION = "execute"
    CATEGORY = "Kolid-Toolkit"
    DESCRIPTION = "Execute custom Python script. Use 'result' variable to return output. Example: result = x + y"
    
    @classmethod
    def VALIDATE_INPUTS(s, input_types):
        return True

    def execute(self, script, x = None, y = None, z = None):
        if not script[0].strip():
            raise ValueError("Script cannot be empty")
        
        # Create local variables from inputs
        local_vars = {
            'x': x,
            'y': y,
            'z': z,
            'result': None
        }
        
        try:
            # Execute the script with full access to builtins
            exec(script[0], globals(), local_vars)
            
            # Return the result variable
            return (local_vars['result'],)
                
        except Exception as e:
            raise ValueError(f"Script execution error: {str(e)}")

            # 在script中必须将结果赋值给result变量
            # 示例用法：
            # script = """
            # x = 10
            # y = 20
            # result = x + y  # 必须赋值给result变量
            # """
