from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # App
    app_env: str = "development"
    app_name: str = "AI Customer Support Assistant"
    app_version: str = "1.0.0"

    # Database
    database_url: str
    postgres_user: str
    postgres_password: str
    postgres_db: str

    # Redis
    redis_url: str
    redis_password: str

    # JWT
    jwt_secret: str
    jwt_refresh_secret: str
    jwt_access_token_expire_minutes: int = 30
    jwt_refresh_token_expire_days: int = 7

    # OpenAI
    openai_api_key: str
    openai_chat_model: str = "gpt-4o"
    openai_embedding_model: str = "text-embedding-3-large"
    openai_embedding_dimensions: int = 3072

    # Pinecone
    pinecone_api_key: str
    pinecone_index_name: str = "ai-support-index"
    pinecone_environment: str = "us-east-1-aws"

    # RAG
    chunk_size: int = 512
    chunk_overlap: int = 50
    top_k_results: int = 5
    min_similarity_score: float = 0.75

    # CORS
    allowed_origins: str = "http://localhost:3000"

    @property
    def allowed_origins_list(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",")]

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
