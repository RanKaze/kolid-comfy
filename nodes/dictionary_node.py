import ast
from math import fabs
from ..libs.utils import AlwaysEqualProxy, compare_revision

any_type = AlwaysEqualProxy("*")
lazy_options = {"lazy": True} if compare_revision(2543) else {}


class DictionaryNewNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "dictionary_text": ("STRING", {"default": "", "multiline": True}),
            },
        }

    RETURN_TYPES = ("DICT",)
    RETURN_NAMES = ("Dict",)
    FUNCTION = "dictionary_new"
    CATEGORY = "Kolid-Toolkit"

    def dictionary_new(self, dictionary_text):
        if not dictionary_text.strip():
            return (dict(),)
        try:
            result = ast.literal_eval(dictionary_text)
            if not isinstance(result, dict):
                raise ValueError("Input string must evaluate to a dictionary")
            return (result,)
        except (SyntaxError, ValueError) as e:
            raise ValueError(f"Invalid dictionary string: {str(e)}")
        
class DictionaryValuesNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "dictionary": ("DICT",),
            },
        }

    RETURN_TYPES = ("LIST",)
    OUTPUT_IS_LIST = (True,)
    RETURN_NAMES = ("values",)
    FUNCTION = "dictionary_values"
    CATEGORY = "Kolid-Toolkit"

    def dictionary_values(self, dictionary):
        """
        Extracts all values from the input dictionary and returns them as a list.
        
        Args:
            dictionary (dict): Input dictionary from which to extract values.
        
        Returns:
            tuple: A tuple containing a single list of dictionary values.
        """
        # Extract values from the dictionary and convert to a list
        values = list(dictionary.values())
        ret = []
        for value in values:
            ret.append(value)
        # Return as a tuple to match ComfyUI's node output format
        return (ret,)


class DictionarySetNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "key": ("STRING", {"default": "", "multiline": False}),
                "value": ("*",),
            },
            "optional": {
                "dictionary": ("DICT",),
            }
        }

    RETURN_TYPES = ("DICT",)
    RETURN_NAMES = ("Dict",)
    FUNCTION = "dictionary_set"
    CATEGORY = "Kolid-Toolkit"
    
    @classmethod
    def VALIDATE_INPUTS(s, input_types):
        return True

    def dictionary_set(self, key, value, dictionary = None):
        if dictionary is None:
            new_dict = dict()
        else:
            new_dict = dictionary.copy()
        if not key:
            raise ValueError("Key cannot be empty")
        
        new_dict[key] = value
        return (new_dict,)
    
class DictIndexSetNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "index": (any_type),
                "key": ("STRING", {"default": "", "multiline": False}),
                "value": ("*",),
            },
            "optional": {
                "dictionary": ("DICT",),
            }
        }

    RETURN_TYPES = ("DICT",)
    RETURN_NAMES = ("Dict",)
    FUNCTION = "dictionary_set"
    CATEGORY = "Kolid-Toolkit"
    
    @classmethod
    def VALIDATE_INPUTS(s, input_types):
        return True

    def dictionary_set(self, index, key, value, dictionary = None):
        if dictionary is None:
            new_dict = dict()   
        else:
            new_dict = dictionary.copy()
        if not key:
            raise ValueError("Key cannot be empty")
        
        key = key + str(index)
        new_dict[key] = value
        return (new_dict,)
    
class DictionaryConditionSetNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "condition": ("STRING", {"default": "", "multiline": False}),
                "key": ("STRING", {"default": "", "multiline": False}),
                "value": ("*",),
            },
            "optional": {
                "dictionary": ("DICT",),
            }
        }

    RETURN_TYPES = ("DICT",)
    RETURN_NAMES = ("Dict",)
    FUNCTION = "dictionary_set"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def VALIDATE_INPUTS(s, input_types):
        return True

    def dictionary_set(self, condition, key, value, dictionary = None):
        if dictionary is None:
            new_dict = dict()
        else:
            new_dict = dictionary.copy()
        if not condition:
            raise ValueError("Condition cannot be empty")
        if not key:
            raise ValueError("Key cannot be empty")
        
        if condition not in new_dict:
            return (new_dict,)
        else:
            flag = new_dict[condition]
            if isinstance(flag, bool):
                if flag:
                     new_dict[key] = value
            else:
                new_dict[key] = value
        return (new_dict,)
    
class DictConditionSetFlag:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "condition": ("STRING", {"default": "", "multiline": False}),
                "key": ("STRING", {"default": "", "multiline": False}),
                "value": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                "dictionary": ("DICT",),
            }
        }

    RETURN_TYPES = ("DICT","BOOLEAN",)
    RETURN_NAMES = ("Dict","Success",)
    FUNCTION = "dictionary_set"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def VALIDATE_INPUTS(s, input_types):
        return True

    def dictionary_set(self, condition, key, value, dictionary = None):
        if dictionary is None:
            new_dict = dict()
        else:
            new_dict = dictionary.copy()
        if not condition:
            raise ValueError("Condition cannot be empty")
        if not key:
            raise ValueError("Key cannot be empty")
        
        if condition not in new_dict:
            return (new_dict, False,)
        else:
            flag = new_dict[condition]
            if isinstance(flag, bool):
                if flag:
                     new_dict[key] = value
                     return (new_dict, True,)
            else:
                new_dict[key] = value
                return (new_dict, True,)
        return (new_dict, False,)
    
class DictSwitch:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "dictionary": ("DICT",),
                "condition": ("STRING", {"default": "", "multiline": False}),
                "key": ("STRING", {"default": "", "multiline": False}),
                "on_failure": (any_type),
            },
            "optional": {
                "on_success": (any_type, lazy_options),
            }
        }

    RETURN_TYPES = ("DICT",any_type,)
    RETURN_NAMES = ("Dict","*",)
    FUNCTION = "branch"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def VALIDATE_INPUTS(s, input_types):
        return True
    
    def check_lazy_status(self, **kwargs):
        dictionary = kwargs['dictionary']
        condition = kwargs['condition']
        key = kwargs['key']
        on_failure = kwargs['on_failure']
        
        if not dictionary:
            raise ValueError("Dictionary cannot be empty")
        if not condition:
            raise ValueError("Condition cannot be empty")
        if not key:
            raise ValueError("Key cannot be empty")
        
        if 'on_success' not in kwargs:
            return []
        if condition not in dictionary:
            return []
        value = dictionary[condition]
        
        if isinstance(value, bool):
            if value:
                return ["on_success"]
            else:
                return []
        return ["on_success"]

    def branch(self, **kwargs):
        dictionary = kwargs['dictionary']
        condition = kwargs['condition']
        key = kwargs['key']
        on_failure = kwargs['on_failure']
        
        if dictionary is None:
            new_dict = dict()
        else:
            new_dict = dictionary.copy()
        if not condition:
            raise ValueError("Condition cannot be empty")
        
        if 'on_success' not in kwargs:
            return (new_dict, on_failure,)     
            
        success = False
        if condition in new_dict:
            flag = new_dict[condition]
            if isinstance(flag, bool):
                if flag:
                    success = True
            else:
                success = True
        if key:
            new_dict[key] = success          
        if success:
            on_success = kwargs['on_success']
            return (new_dict, on_success,)
        else:
            return (new_dict, on_failure,)

class DictionaryListSetNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "key": ("STRING", {"default": "", "multiline": False}),
                "values": ("*",),
            },
            "optional": {
                "dictionary": ("DICT",),
            }
        }

    RETURN_TYPES = ("DICT",)
    RETURN_NAMES = ("Dict",)
    INPUT_IS_LIST = True
    OUTPUT_IS_LIST = (True,)
    FUNCTION = "dictionary_set"
    CATEGORY = "Kolid-Toolkit"
    
    @classmethod
    def VALIDATE_INPUTS(s, input_types):
        return True

    def dictionary_set(self, key, values, dictionary = None):
        if dictionary is None:
            template = dict()
        else:
            template = dictionary[0]

        if not key:
            raise ValueError("Key cannot be empty")
        
        ret = []
        index = 0
        for value in values:
            new_dict = template.copy()
            new_dict[key[0]] = value
            ret.append(new_dict)
        
        return (ret,)

class DictionaryGetNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "dictionary": ("DICT",),
                "key": ("STRING", {"default": "", "multiline": False}),
            }
        }
        

    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("*",)
    FUNCTION = "dictionary_get"
    CATEGORY = "Kolid-Toolkit"

    def dictionary_get(self, dictionary, key):
        if not isinstance(dictionary, dict):
            raise ValueError("Input 'dictionary' must be a valid dictionary")
        if not key:
            raise ValueError("Key cannot be empty")
        try:
            value = dictionary[key]
            return (value,)
        except KeyError:
            raise ValueError(f"Key '{key}' not found in the dictionary")
        
class DictIndexGetNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "dictionary": ("DICT",),
                "index": (any_type),
                "key": ("STRING", {"default": "", "multiline": False}),
            }
        }

    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("value",)
    FUNCTION = "dictionary_get"
    CATEGORY = "Kolid-Toolkit"
    
    @classmethod
    def VALIDATE_INPUTS(s, input_types):
        return True

    def dictionary_get(self, dictionary, index, key):
        if not isinstance(dictionary, dict):
            raise ValueError("Input 'dictionary' must be a valid dictionary")
        if not key:
            raise ValueError("Key cannot be empty")
        
        # Construct the indexed key
        indexed_key = key + str(index)
        
        try:
            value = dictionary[indexed_key]
            return (value,)
        except KeyError:
            raise ValueError(f"Key '{indexed_key}' not found in the dictionary")


class DictionaryGetIntNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "dictionary": ("DICT",),
                "key": ("STRING", {"default": "", "multiline": False}),
            }
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("value",)
    FUNCTION = "dictionary_get"
    CATEGORY = "Kolid-Toolkit"

    def dictionary_get(self, dictionary, key):
        if not isinstance(dictionary, dict):
            raise ValueError("Input 'dictionary' must be a valid dictionary")
        if not key:
            raise ValueError("Key cannot be empty")
        try:
            value = dictionary[key]
            if isinstance(value, (int, float)):
                return (int(value),)
            elif isinstance(value, str) and value.replace("-", "").replace(".", "").isdigit():
                return (int(value),)
            else:
                raise ValueError(f"Value '{value}' cannot be converted to INT")
        except KeyError:
            raise ValueError(f"Key '{key}' not found in the dictionary")
        
        
class DictionaryGetBooleanNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "dictionary": ("DICT",),
                "key": ("STRING", {"default": "", "multiline": False}),
            }
        }

    RETURN_TYPES = ("DICT", "BOOLEAN",)
    RETURN_NAMES = ("dict", "flag",)
    FUNCTION = "dictionary_get"
    CATEGORY = "Kolid-Toolkit"

    def dictionary_get(self, dictionary, key):
        if not isinstance(dictionary, dict):
            raise ValueError("Input 'dictionary' must be a valid dictionary")
        if not key:
            raise ValueError("Key cannot be empty")
        if key not in dictionary:
            return (dictionary, False,)
        value = dictionary[key]
        if isinstance(value, bool):
            return (dictionary,value,)
        return (dictionary,True,)


class DictionaryGetStringNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "dictionary": ("DICT",),
                "key": ("STRING", {"default": "", "multiline": False}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("value",)
    FUNCTION = "dictionary_get"
    CATEGORY = "Kolid-Toolkit"

    def dictionary_get(self, dictionary, key):
        if not isinstance(dictionary, dict):
            raise ValueError("Input 'dictionary' must be a valid dictionary")
        if not key:
            raise ValueError("Key cannot be empty")
        try:
            value = dictionary[key]
            return (str(value),)
        except KeyError:
            raise ValueError(f"Key '{key}' not found in the dictionary")

class DictionaryGetFloatNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "dictionary": ("DICT",),
                "key": ("STRING", {"default": "", "multiline": False}),
            }
        }

    RETURN_TYPES = ("FLOAT",)
    RETURN_NAMES = ("value",)
    FUNCTION = "dictionary_get"
    CATEGORY = "Kolid-Toolkit"

    def dictionary_get(self, dictionary, key):
        if not isinstance(dictionary, dict):
            raise ValueError("Input 'dictionary' must be a valid dictionary")
        if not key:
            raise ValueError("Key cannot be empty")
        try:
            value = dictionary[key]
            if isinstance(value, (int, float)):
                return (float(value),)
            elif isinstance(value, str) and value.replace("-", "").replace(".", "").isdigit():
                return (float(value),)
            else:
                raise ValueError(f"Value '{value}' cannot be converted to FLOAT")
        except KeyError:
            raise ValueError(f"Key '{key}' not found in the dictionary")
        