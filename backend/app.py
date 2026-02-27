from src.routes import rag_routes

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
import os
from dotenv import load_dotenv

load_dotenv()

# --- Rate Limiter ---
limiter = Limiter(key_func=get_remote_address)

app = FastAPI(title="IMS Chatbot", version="1.0.0")
app.state.limiter = limiter

# Custom 429 handler with a user-friendly JSON response
@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=429,
        content={
            "error": "rate_limit_exceeded",
            "detail": "Too many requests. Please wait a moment before trying again.",
        },
    )
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=os.getenv("ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")
)

# -------------------------
# Security: CORS Configuration
# -------------------------
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")
ALLOWED_CREDENTIALS = os.getenv("ALLOW_CREDENTIALS", "true").lower() == "true"
ALLOWED_METHODS = ["*"]
ALLOWED_HEADERS = ["Content-Type", "Authorization"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in ALLOWED_ORIGINS],
    allow_credentials=ALLOWED_CREDENTIALS,
    allow_methods=ALLOWED_METHODS,
    allow_headers=ALLOWED_HEADERS,
    max_age=3600,  # Cache preflight for 1 hour
)

# -------------------------
# Security: Custom Headers Middleware
# -------------------------
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    response.headers["Content-Security-Policy"] = "default-src 'self'"
    return response

app.include_router(rag_routes.router, prefix="/api")

@app.get("/")
def root():
    """Simple root endpoint"""
    return {"message": "ARSBTP backend is running successfully!"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
