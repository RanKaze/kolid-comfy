from ..libs.timestamp import parse_timestamp, format_timestamp
from comfy_api.latest import ComfyExtension, io, ui, Input, InputImpl, Types


class TimestampDurationNode:
    """Calculate duration between two timestamps and return as timestamp."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "start_timestamp": ("STRING", {
                    "default": "00:00:00",
                    "multiline": False,
                    "tooltip": "Start timestamp in hh:mm:ss format",
                }),
                "end_timestamp": ("STRING", {
                    "default": "00:01:00",
                    "multiline": False,
                    "tooltip": "End timestamp in hh:mm:ss format",
                }),
            },
        }

    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("duration_timestamp", "duration_seconds")
    FUNCTION = "calculate_duration"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(s, start_timestamp, end_timestamp):
        return f"{start_timestamp}_{end_timestamp}"

    def calculate_duration(self, start_timestamp, end_timestamp):
        """Calculate duration between two timestamps."""
        start_seconds = parse_timestamp(start_timestamp)
        end_seconds = parse_timestamp(end_timestamp)
        
        if start_seconds > end_seconds:
            raise ValueError("Start timestamp must be before end timestamp")
        
        duration_seconds = end_seconds - start_seconds
        duration_timestamp = format_timestamp(duration_seconds)
        
        return (duration_timestamp, duration_seconds)


class TimestampForLengthNode:
    """Calculate timestamp after adding specified seconds to input timestamp."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "input_timestamp": ("STRING", {
                    "default": "00:00:00",
                    "multiline": False,
                    "tooltip": "Input timestamp in hh:mm:ss format",
                }),
                "seconds": ("INT", {
                    "default": 60,
                    "min": -3600,
                    "max": 3600,
                    "step": 1,
                    "tooltip": "Seconds to add (negative to subtract)",
                }),
            },
        }

    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("result_timestamp", "result_seconds")
    FUNCTION = "calculate_result"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(s, input_timestamp, seconds):
        return f"{input_timestamp}_{seconds}"

    def calculate_result(self, input_timestamp, seconds):
        """Calculate result timestamp by adding seconds to input timestamp."""
        input_seconds = parse_timestamp(input_timestamp)
        result_seconds = input_seconds + seconds
        
        if result_seconds < 0:
            result_seconds = 0
        
        result_timestamp = format_timestamp(result_seconds)
        
        return (result_timestamp, result_seconds)
