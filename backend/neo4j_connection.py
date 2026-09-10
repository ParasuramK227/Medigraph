import os
from neo4j import GraphDatabase


_driver = None


def get_driver():
    global _driver
    if _driver is None:
        uri = os.environ["NEO4J_URI"]
        user = os.environ["NEO4J_USER"]
        password = os.environ["NEO4J_PASSWORD"]
        _driver = GraphDatabase.driver(uri, auth=(user, password))
    return _driver


def get_session():
    return get_driver().session()


def check_connectivity():
    try:
        driver = get_driver()
        with driver.session() as session:
            session.run("RETURN 1")
        return True
    except Exception:
        return False


def is_connected() -> bool:
    """Short-circuit connectivity check used by offline-ready routes."""
    return check_connectivity()


def close():
    global _driver
    if _driver is not None:
        _driver.close()
        _driver = None
