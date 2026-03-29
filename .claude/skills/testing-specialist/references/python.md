# Python Testing Reference

## Framework: pytest (standard)

### Setup
```bash
pip install pytest pytest-cov pytest-mock pytest-asyncio
```

```toml
# pyproject.toml
[tool.pytest.ini_options]
testpaths = ["tests"]
markers = [
    "unit: fast isolated tests",
    "integration: tests with real dependencies",
    "e2e: full system tests",
]
addopts = "-v --tb=short"

[tool.coverage.run]
source = ["src"]
omit = ["*/tests/*", "*/migrations/*"]

[tool.coverage.report]
fail_under = 80
show_missing = true
```

### Unit Tests
```python
import pytest
from myapp.pricing import calculate_discount

class TestCalculateDiscount:
    def test_applies_percentage(self):
        assert calculate_discount(price=100.0, discount_pct=10) == 90.0

    def test_zero_discount_returns_original(self):
        assert calculate_discount(price=50.0, discount_pct=0) == 50.0

    def test_negative_price_raises(self):
        with pytest.raises(ValueError, match="Price must be non-negative"):
            calculate_discount(price=-10.0, discount_pct=5)

    @pytest.mark.parametrize("price,pct,expected", [
        (100, 0, 100), (100, 50, 50), (100, 100, 0), (0, 50, 0),
    ])
    def test_boundary_values(self, price, pct, expected):
        assert calculate_discount(price, pct) == expected
```

### Mocking
```python
def test_sends_email(mocker):
    mock_send = mocker.patch("myapp.notifications.email_client.send")
    send_notification(user_id=42, message="Hello")
    mock_send.assert_called_once_with(to="user42@example.com", body="Hello")
```
Use `mocker.patch` (pytest-mock) — auto-cleans up after test.

### Fixtures
```python
@pytest.fixture
def sample_user():
    return User(id=1, name="Alice", email="alice@test.com")

@pytest.fixture
def db_session():
    session = create_test_session()
    yield session
    session.rollback()
    session.close()
```

### Integration: FastAPI
```python
from fastapi.testclient import TestClient
from myapp.main import app

@pytest.fixture
def client():
    return TestClient(app)

@pytest.mark.integration
def test_create_item(client):
    res = client.post("/items", json={"name": "Widget", "price": 9.99})
    assert res.status_code == 201
    assert res.json()["name"] == "Widget"
```

### Integration: Django
```python
import pytest
from django.test import Client

@pytest.mark.django_db
def test_create_user():
    client = Client()
    res = client.post("/api/users/", {"name": "Alice", "email": "a@b.com"},
                      content_type="application/json")
    assert res.status_code == 201
```

### Async
```python
@pytest.mark.asyncio
async def test_async_fetch():
    result = await fetch_data(source="test")
    assert result is not None
```

### Running
```bash
pytest                              # all
pytest -m unit                      # by marker
pytest --cov=src --cov-report=term  # with coverage
pytest -x                           # stop on first failure
```
