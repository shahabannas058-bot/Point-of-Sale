using Xunit;

namespace PosShell.Infrastructure.Tests;

public sealed class FileLogTests
{
    [Fact]
    public void An_entry_is_one_line_and_values_that_look_like_secrets_are_redacted()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"pos-log-{Guid.NewGuid():N}");
        try
        {
            var log = new FileLog(dir);
            log.Error("test", new InvalidOperationException("pin: 1234, \"token\": \"abc\"\nsecond line"), "r1");

            var line = Assert.Single(File.ReadAllLines(Assert.Single(Directory.GetFiles(dir, "pos-*.log"))));
            Assert.Contains(" ERROR test id=r1 ", line);
            Assert.Contains("pin: [redacted]", line);
            Assert.Contains("\"token\": [redacted]", line);
            Assert.DoesNotContain("pin: 1234", line);
            Assert.DoesNotContain("\"abc\"", line);
            Assert.Contains("| second line", line);
        }
        finally { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void A_missing_request_id_is_written_as_a_dash_and_writing_never_throws()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"pos-log-{Guid.NewGuid():N}");
        var blocker = Path.Combine(Path.GetTempPath(), $"pos-log-{Guid.NewGuid():N}.txt");
        try
        {
            var log = new FileLog(dir);
            log.Info("startup", "hello");
            Assert.Contains(" INFO startup id=- hello", Assert.Single(File.ReadAllLines(Assert.Single(Directory.GetFiles(dir)))));

            File.WriteAllText(blocker, "");
            new FileLog(blocker).Info("startup", "dropped"); // the "folder" is a file: CreateDirectory fails, nothing is thrown
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
            if (File.Exists(blocker)) File.Delete(blocker);
        }
    }
}
