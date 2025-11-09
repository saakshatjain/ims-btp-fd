# backend/app.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from src.routes import rag_routes

# Initialize FastAPI app
app = FastAPI(title="ARSBTP RAG API", version="1.0")

# CORS (so frontend can access backend)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # for dev; restrict later to your frontend URL
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include your RAG routes
app.include_router(rag_routes.router, prefix="/api")

@app.get("/")
def root():
    """Simple root endpoint"""
    return {"message": "ARSBTP backend is running successfully!"}

# Only needed if you want to run directly as `python app.py`
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
