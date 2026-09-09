import os
import tempfile
from flask import Flask
from flask_cors import CORS
from dotenv import load_dotenv

from backend.neo4j_connection import check_connectivity as neo4j_check


def create_app():
    load_dotenv()

    app = Flask(__name__)
    app.config["UPLOAD_TEMP_DIR"] = os.getenv("UPLOAD_TEMP_DIR", tempfile.gettempdir())

    cors_origins = os.getenv("CORS_ORIGINS", "*")
    if cors_origins == "*":
        CORS(app, resources={r"/api/*": {"origins": "*"}})
    else:
        origins = [o.strip() for o in cors_origins.split(",") if o.strip()]
        CORS(app, resources={r"/api/*": {"origins": origins}})

    from backend.routes.scribe import scribe_bp
    from backend.routes.graph import graph_bp
    from backend.routes.chat import chat_bp
    from backend.routes.auth import auth_bp

    app.register_blueprint(scribe_bp, url_prefix="/api/scribe")
    app.register_blueprint(graph_bp, url_prefix="/api/graph")
    app.register_blueprint(chat_bp, url_prefix="/api/chat")
    app.register_blueprint(auth_bp, url_prefix="/api/auth")

    # Idempotent demo-account bootstrap. Best-effort so the app can still boot
    # (and report a degraded health status) if Neo4j is unavailable.
    try:
        from backend import user_store
        user_store.bootstrap_demo_users()
    except Exception as e:
        app.logger.warning("Demo user bootstrap skipped: %s", e)

    @app.route("/api/health")
    def health():
        neo4j_ok = neo4j_check()
        return {
            "status": "ok" if neo4j_ok else "degraded",
            "neo4j": "connected" if neo4j_ok else "disconnected",
        }

    # Serve built React frontend if dist exists (unified deployment mode)
    dist_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend", "dist"))
    if os.path.isdir(dist_dir):
        from flask import send_from_directory

        @app.route("/", defaults={"path": ""})
        @app.route("/<path:path>")
        def serve_frontend(path):
            file_path = os.path.join(dist_dir, path)
            if path and os.path.exists(file_path):
                return send_from_directory(dist_dir, path)
            return send_from_directory(dist_dir, "index.html")
    else:
        @app.route("/")
        def root():
            neo4j_ok = neo4j_check()
            return {
                "service": "MediGraph Backend API",
                "status": "online",
                "neo4j": "connected" if neo4j_ok else "disconnected",
                "health_endpoint": "/api/health",
                "frontend": "https://medigraph-frontend.onrender.com",
            }

    return app


if __name__ == "__main__":
    app = create_app()
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=os.getenv("FLASK_DEBUG", "0") == "1")

