"""Shared, closed configuration vocabulary. No paths, commands or URLs from HTTP."""
DEFAULTS = {"model": "base.en", "voice": "af_heart", "threshold": 0.5,
            "silenceMs": 700, "speed": 1.0, "device": "cpu"}


def validate(value):
    if not isinstance(value, dict) or set(value) != set(DEFAULTS):
        raise ValueError("Provide only the supported Voice Box settings")
    if value["model"] not in ("tiny.en", "base.en"):
        raise ValueError("Unsupported transcription model")
    if value["voice"] not in ("af_heart", "af_bella"):
        raise ValueError("Unsupported voice")
    if value["device"] not in ("cpu", "cuda"):
        raise ValueError("Unsupported device")
    for key, low, high in (("threshold", 0.2, 0.9), ("silenceMs", 300, 1800), ("speed", 0.7, 1.4)):
        if type(value[key]) not in (int, float) or not low <= value[key] <= high:
            raise ValueError("Invalid " + key)
    return dict(value)
