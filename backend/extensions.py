from slowapi import Limiter
from slowapi.util import get_remote_address

# Shared rate limiter instance – imported by both app.py and route modules.
limiter = Limiter(key_func=get_remote_address)
