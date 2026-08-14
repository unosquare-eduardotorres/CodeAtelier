// C# fixture for the complexity analyzer. Every function's expected score is
// hand-computed from `1 + decision points` and pinned in
// complexity-analyzer.test.ts — the walker is only as trustworthy as these.

using System;

namespace Fixture
{
    public class Analyzer
    {
        private readonly int _raw;

        // ctor: 1 + ternary = 2
        public Analyzer(int raw)
        {
            _raw = raw > 0 ? raw : 0;
        }

        // Simple: 1 (no decision points)
        public int Simple(int x)
        {
            return x;
        }

        // Guarded: 1 + if + && = 3   (else is never counted)
        public int Guarded(int x, int y)
        {
            if (x > 0 && y > 0)
            {
                return 1;
            }
            else
            {
                return 0;
            }
        }

        // Loops: 1 + for + foreach + while + do = 5
        public int Loops(int[] items)
        {
            var total = 0;
            for (var i = 0; i < items.Length; i++)
            {
                total += i;
            }
            foreach (var item in items)
            {
                total += item;
            }
            while (total > 100)
            {
                total--;
            }
            do
            {
                total++;
            } while (total < 0);
            return total;
        }

        // Classify: 1 + case 1 + case 2 = 3   (default_switch_label NOT counted)
        public string Classify(int code)
        {
            switch (code)
            {
                case 1:
                    return "one";
                case 2:
                    return "two";
                default:
                    return "other";
            }
        }

        // Describe: 1 + arm 1 + arm 2 = 3   (the `_ =>` discard arm NOT counted)
        public string Describe(int code) => code switch
        {
            1 => "one",
            2 => "two",
            _ => "other"
        };

        // Risky: 1 + catch + when-filter + catch = 4   (finally NOT counted)
        public int Risky(string raw)
        {
            try
            {
                return int.Parse(raw);
            }
            catch (FormatException e) when (e.Message.Length > 0)
            {
                return -1;
            }
            catch (Exception)
            {
                return -2;
            }
            finally
            {
                Console.WriteLine("done");
            }
        }

        // Coalesce: 1 + ?. + ?? + ternary = 4
        public string Coalesce(Config config)
        {
            var name = config?.Name ?? "unknown";
            var label = name.Length > 3 ? "long" : "short";
            return label;
        }

        // Match: 1 + and_pattern + or_pattern = 3
        public bool Match(object value)
        {
            return value is int and > 0 or string;
        }

        // Outer: 1 + if = 2. The lambda is a SEPARATE scope: 1 + ternary = 2.
        public int Outer(int[] values)
        {
            if (values.Length == 0)
            {
                return 0;
            }
            Func<int, int> abs = v => v > 0 ? v : -v;
            return abs(values[0]);
        }

        // WithLocal: 1 — the local function is scored on its own (1 + ternary = 2).
        public int WithLocal(int x)
        {
            int Helper(int v)
            {
                return v > 0 ? 1 : 0;
            }
            return Helper(x);
        }

        // Accessor scope: 1 + if = 2, reported as accessor@<line>.
        public int Value
        {
            get
            {
                if (_raw > 0)
                {
                    return _raw;
                }
                return 0;
            }
        }
    }

    public class Config
    {
        public string Name { get; set; }
    }
}
