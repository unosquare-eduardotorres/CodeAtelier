# Python fixture for the complexity analyzer. Expected scores are hand-computed
# (`1 + decision points`) and pinned in complexity-analyzer.test.ts.


# simple: 1
def simple(x):
    return x


# guarded: 1 + if + and + elif = 4
# `and` lives on `boolean_operator`, NOT `binary_operator` — a single global
# operator set would silently score this 3.
def guarded(x, y):
    if x > 0 and y > 0:
        return 1
    elif x == 0:
        return 0
    else:
        return -1


# loops: 1 + for + while = 3
def loops(items):
    total = 0
    for item in items:
        total += item
    while total > 10:
        total -= 1
    return total


# classify: 1 + case(1|2) + union_pattern + guarded case + its guard = 5
# The bare `case _:` is fallthrough — not counted.
def classify(code):
    match code:
        case 1 | 2:
            return "low"
        case str() if code:
            return "text"
        case _:
            return "other"


# risky: 1 + except + except = 3   (finally NOT counted)
def risky(raw):
    try:
        return int(raw)
    except ValueError:
        return -1
    except TypeError:
        return -2
    finally:
        pass


# comprehension: 1 + for_in_clause + if_clause = 3
def comprehension(items):
    return [i for i in items if i > 0]


# checked: 1 + assert + conditional_expression = 3
def checked(x):
    assert x
    y = 1 if x else 2
    return y


# outer: 1 + if = 2. The lambda is a SEPARATE scope: 1 + conditional = 2.
def outer(values):
    if not values:
        return 0
    f = lambda v: v if v > 0 else -v
    return f(values[0])


# with_and_else: 1 — `with`, `else` and `try/finally` add no path.
def with_and_else(path):
    with open(path) as handle:
        return handle.read()
