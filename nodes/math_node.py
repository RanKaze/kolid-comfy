from ..libs.utils import AlwaysEqualProxy, compare_revision
import math

any_type = AlwaysEqualProxy("*")
lazy_options = {"lazy": True} if compare_revision(2543) else {}


class MathNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "math_expression": ("STRING", {"default": "", "multiline": True}),
            },
            "optional": {
                "x": (any_type),
                "y": (any_type),
                "z": (any_type),
            }
        }

    RETURN_TYPES = ("INT", "FLOAT",)
    RETURN_NAMES = ("int", "float")
    FUNCTION = "calculate"
    CATEGORY = "Kolid-Toolkit"
    
    @classmethod
    def VALIDATE_INPUTS(s, input_types):
        return True

    def calculate(self, math_expression, x = None, y = None, z = None):
        if not math_expression.strip():
            raise ValueError("Math expression cannot be empty")
        
        # Convert inputs to appropriate types for calculation
        try:
            x_val = float(x) if x is not None else 0.0
            y_val = float(y) if y is not None else 0.0
            z_val = float(z) if z is not None else 0.0
        except (ValueError, TypeError):
            raise ValueError("Inputs x, y, z must be convertible to numbers")
        
        # Create a safe math environment with only allowed operations
        allowed_names = {
            'x': x_val, 'y': y_val, 'z': z_val,
            'abs': abs, 'round': round, 'min': min, 'max': max,
            'pow': pow, 'sqrt': math.sqrt,
            'sin': math.sin, 'cos': math.cos, 'tan': math.tan,
            'log': math.log, 'log10': math.log10, 'exp': math.exp,
            'floor': math.floor, 'ceil': math.ceil,
            'pi': math.pi, 'e': math.e
        }
        
        try:
            # Evaluate the math expression safely
            result = eval(math_expression, {"__builtins__": {}}, allowed_names)
            
            # Convert result to appropriate types
            if isinstance(result, (int, float)):
                int_result = int(result)
                float_result = float(result)
                return (int_result, float_result,)
            else:
                raise ValueError("Math expression must evaluate to a number")
                
        except Exception as e:
            raise ValueError(f"Invalid math expression: {str(e)}")