using System.Text.Json.Nodes;

namespace CodexGui;

/// <summary>.NET 7 里没有 JsonNode.DeepClone，用序列化做一个等价的深拷贝。</summary>
internal static class JsonNodeExtensions
{
    public static T DeepClone<T>(this T node) where T : JsonNode
        => (T)JsonNode.Parse(node.ToJsonString())!;
}
