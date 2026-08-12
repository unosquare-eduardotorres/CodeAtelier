// C# fixture for the tree-sitter query-pack regression guard.
// Deliberately exercises the capture patterns csharp-tags.scm claims to
// support: namespace, interface, class + base list, methods, object creation,
// generic constraints and member-access invocations.

namespace Atelier.Sample
{
    public interface IGreeter
    {
        string Greet(string name);
    }

    public class Greeter : IGreeter
    {
        private readonly string _prefix;

        public Greeter(string prefix)
        {
            _prefix = prefix;
        }

        public string Greet(string name)
        {
            var builder = new StringBuilder();
            builder.Append(_prefix);
            return builder.ToString();
        }
    }

    public class Repository<T> where T : IGreeter
    {
        public T Resolve(string key)
        {
            return default(T);
        }
    }
}
