using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodexGui.Services;

/// <summary>会话（对话）持久化：&lt;数据目录&gt;\sessions\&lt;id&gt;.json（见 <see cref="StoragePaths"/>）</summary>
public sealed class SessionStore
{
    private static readonly JsonSerializerOptions WriteOptions = new()
    {
        WriteIndented = false,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public SessionStore()
    {
        Directory.CreateDirectory(AppConfig.SessionsDir);
    }

    private static string PathFor(string id) => Path.Combine(AppConfig.SessionsDir, id + ".json");

    public static string NewId() => DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N")[..6];

    public JsonObject Create(string workDir, string model, string sandbox)
    {
        var now = DateTimeOffset.Now.ToUnixTimeMilliseconds();
        var session = new JsonObject
        {
            ["id"] = NewId(),
            ["title"] = "",
            ["workDir"] = workDir,
            ["threadId"] = null,
            ["model"] = model,
            ["sandbox"] = sandbox,
            ["createdAt"] = now,
            ["updatedAt"] = now,
            ["messages"] = new JsonArray(),
        };
        Save(session);
        return session;
    }

    public JsonObject? Load(string id)
    {
        try
        {
            var path = PathFor(id);
            if (!File.Exists(path)) return null;
            return JsonNode.Parse(File.ReadAllText(path)) as JsonObject;
        }
        catch
        {
            return null;
        }
    }

    public void Save(JsonObject session, bool touchTimestamp = true)
    {
        try
        {
            var id = session["id"]?.GetValue<string>();
            if (string.IsNullOrEmpty(id)) return;
            Directory.CreateDirectory(AppConfig.SessionsDir);
            if (touchTimestamp) session["updatedAt"] = DateTimeOffset.Now.ToUnixTimeMilliseconds();
            File.WriteAllText(PathFor(id), session.ToJsonString(WriteOptions));
        }
        catch
        {
            // 忽略磁盘写入异常，界面仍有内存中的副本。
        }
    }

    public void Delete(string id)
    {
        try
        {
            var path = PathFor(id);
            if (File.Exists(path)) File.Delete(path);
        }
        catch
        {
            // ignored
        }
    }

    /// <summary>返回会话摘要列表（不含消息体），按更新时间倒序。</summary>
    public List<JsonObject> List()
    {
        var result = new List<JsonObject>();
        try
        {
            foreach (var file in Directory.EnumerateFiles(AppConfig.SessionsDir, "*.json"))
            {
                try
                {
                    var node = JsonNode.Parse(File.ReadAllText(file)) as JsonObject;
                    if (node is null) continue;
                    var messages = node["messages"] as JsonArray;
                    var preview = "";
                    if (messages is { Count: > 0 })
                    {
                        var first = messages[0] as JsonObject;
                        preview = first?["text"]?.GetValue<string>() ?? "";
                        if (preview.Length > 90) preview = preview[..90];
                    }

                    result.Add(new JsonObject
                    {
                        ["id"] = node["id"]?.GetValue<string>(),
                        ["title"] = node["title"]?.GetValue<string>() ?? "",
                        ["preview"] = preview,
                        ["workDir"] = node["workDir"]?.GetValue<string>(),
                        ["updatedAt"] = node["updatedAt"]?.GetValue<long>() ?? 0,
                        ["createdAt"] = node["createdAt"]?.GetValue<long>() ?? 0,
                        ["messageCount"] = messages?.Count ?? 0,
                        ["threadId"] = node["threadId"]?.GetValue<string>(),
                    });
                }
                catch
                {
                    // 跳过损坏的会话文件
                }
            }
        }
        catch
        {
            // ignored
        }

        return result.OrderByDescending(s => s["updatedAt"]?.GetValue<long>() ?? 0).ToList();
    }
}
