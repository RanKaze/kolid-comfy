class TypeDebugNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "any": ("*",{}),
            }
        }


    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("log",)
    FUNCTION = "type_debug"
    CATEGORY = "Kolid-Toolkit"

    def type_debug(self, any):
        log = ""
        log += type(any).__name__
        log += ','
        while any is list:
            any = any[0]
            log += type(any).__name__
            log += ','
        print(log)
        return log
    
    @classmethod
    def VALIDATE_INPUTS(s, input_types):
        return True