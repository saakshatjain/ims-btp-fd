from src.routes import rag_routes

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
import os
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="IMS Chatbot", version="1.0.0")
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
