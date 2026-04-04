def parse_timestamp(timestamp_str):
    """Parse timestamp string (hh:mm:ss) to seconds."""
    parts = timestamp_str.strip().split(':')
    
    if len(parts) == 3:
        hours, minutes, seconds = parts
    elif len(parts) == 2:
        hours = 0
        minutes, seconds = parts
    elif len(parts) == 1:
        hours = 0
        minutes = 0
        seconds = parts[0]
    else:
        raise ValueError("Invalid timestamp format")
    
    try:
        hours = int(hours)
        minutes = int(minutes)
        seconds = float(seconds)
    except ValueError:
        raise ValueError("Invalid timestamp format")
    
    total_seconds = hours * 3600 + minutes * 60 + seconds
    return total_seconds


def format_timestamp(seconds):
    """Format seconds to timestamp string (hh:mm:ss)."""
    hours = int(seconds // 3600)
    remaining = seconds % 3600
    minutes = int(remaining // 60)
    secs = remaining % 60
    
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{secs:06.3f}".rstrip('0').rstrip('.')
    else:
        return f"{minutes:02d}:{secs:06.3f}".rstrip('0').rstrip('.')
