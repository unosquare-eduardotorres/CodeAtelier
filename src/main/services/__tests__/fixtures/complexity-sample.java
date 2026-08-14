// Java fixture for the complexity analyzer. Expected scores are hand-computed
// (`1 + decision points`) and pinned in complexity-analyzer.test.ts.

class Fixture {
    private int seed;

    // ctor: 1 + ternary = 2
    Fixture(int x) {
        this.seed = x > 0 ? x : 0;
    }

    // simple: 1
    int simple(int x) {
        return x;
    }

    // guarded: 1 + if + && = 3   (else never counted)
    int guarded(int x, int y) {
        if (x > 0 && y > 0) {
            return 1;
        } else {
            return 0;
        }
    }

    // loops: 1 + for + enhanced-for + while + do = 5
    int loops(int[] items) {
        int n = 0;
        for (int i = 0; i < items.length; i++) {
            n += i;
        }
        for (int item : items) {
            n += item;
        }
        while (n > 100) {
            n--;
        }
        do {
            n++;
        } while (n < 0);
        return n;
    }

    // classify: 1 + case 1 + case 2 = 3   ← `default:` is a switch_label too
    // and must NOT be counted, or every Java switch inflates by one.
    String classify(int code) {
        switch (code) {
            case 1:
                return "one";
            case 2:
                return "two";
            default:
                return "other";
        }
    }

    // arrow: 1 + case 1 = 2   (`default ->` is also a switch_label — not counted)
    String arrow(int code) {
        return switch (code) {
            case 1 -> "one";
            default -> "other";
        };
    }

    // risky: 1 + catch + catch = 3   (finally NOT counted)
    int risky(String raw) {
        try {
            return Integer.parseInt(raw);
        } catch (NumberFormatException e) {
            return -1;
        } catch (Exception e) {
            return -2;
        } finally {
            System.out.println("done");
        }
    }

    // ternary: 1 + ternary = 2
    int ternary(int x) {
        return x > 0 ? 1 : -1;
    }

    // outer: 1 + if = 2. The lambda is a SEPARATE scope: 1 + if = 2.
    int outer(int x) {
        if (x > 0) {
            return 1;
        }
        Runnable r = () -> {
            if (x < 0) {
                System.out.println("negative");
            }
        };
        r.run();
        return 0;
    }
}
