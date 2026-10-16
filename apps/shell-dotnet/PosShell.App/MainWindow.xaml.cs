using System.Diagnostics;
using System.IO;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using PosShell.Infrastructure;

namespace PosShell.Desktop;

public partial class MainWindow : Window
{
    /// <summary>The React build is served from this fake HTTPS host (a secure context: modules, crypto.randomUUID, etc.).</summary>
    private const string Host = "app.pos";

#if DEBUG
    /// <summary>While developing: set POS_DEV_URL=http://localhost:5173 and run `npm run dev` for hot reload inside the shell.</summary>
    private static readonly string? DevUrl = Environment.GetEnvironmentVariable("POS_DEV_URL");
#else
    private static readonly string? DevUrl = null;
#endif

    private readonly WebBridge _bridge;

    public MainWindow(WebBridge bridge)
    {
        _bridge = bridge;
        InitializeComponent();
        Loaded += async (_, _) =>
        {
            try { await InitializeWebAsync(); }
            catch (Exception ex)
            {
                MessageBox.Show($"WebView2 start nahi ho saka:\n{ex.Message}\n\nWebView2 Runtime install hona chahiye.",
                    "POS", MessageBoxButton.OK, MessageBoxImage.Error);
                Close();
            }
        };
    }

    private async Task InitializeWebAsync()
    {
        // WebView2's own profile (cookies, cache, localStorage) lives apart from pos.db: clearing it cannot touch shop data.
        Directory.CreateDirectory(PosPaths.WebViewDir);
        var env = await CoreWebView2Environment.CreateAsync(browserExecutableFolder: null, userDataFolder: PosPaths.WebViewDir);
        await Web.EnsureCoreWebView2Async(env);
        var core = Web.CoreWebView2;

        var s = core.Settings;
#if DEBUG
        s.AreDevToolsEnabled = true;
#else
        s.AreDevToolsEnabled = false;
        s.AreBrowserAcceleratorKeysEnabled = false;
#endif
        s.AreDefaultContextMenusEnabled = false;
        s.IsStatusBarEnabled = false;
        s.IsZoomControlEnabled = false;
        s.IsPasswordAutosaveEnabled = false;
        s.IsGeneralAutofillEnabled = false;

        var wwwroot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        if (DevUrl is null && !File.Exists(Path.Combine(wwwroot, "index.html")))
        {
            MessageBox.Show("wwwroot/index.html nahi mila. Pehle chalayein:\n  npm run build -w @pos/desktop\nphir shell dobara build karein.",
                "POS", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        core.SetVirtualHostNameToFolderMapping(Host, wwwroot, CoreWebView2HostResourceAccessKind.Deny);
        core.NavigationStarting += (_, e) => { if (!IsAllowed(e.Uri)) e.Cancel = true; };   // never browse away from our own UI
        core.NewWindowRequested += (_, e) => e.Handled = true;
        core.DownloadStarting += (_, e) => e.Cancel = true;
        core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
        core.WebMessageReceived += OnWebMessageReceived;

        core.Navigate(DevUrl ?? $"https://{Host}/index.html");
    }

    private static bool IsAllowed(string? uri)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var u)) return false;
        if (u.Scheme == Uri.UriSchemeHttps && string.Equals(u.Host, Host, StringComparison.OrdinalIgnoreCase)) return true;
        return DevUrl is not null && Uri.TryCreate(DevUrl, UriKind.Absolute, out var dev)
            && string.Equals(u.GetLeftPart(UriPartial.Authority), dev.GetLeftPart(UriPartial.Authority), StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// React called window.chrome.webview.postMessage({ id, method, payload }). WebBridge parses it as JsonElement,
    /// runs it (checkout.commit goes through SalesService) and always returns a reply JSON, which is posted back.
    /// </summary>
    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!IsAllowed(e.Source)) return; // only our own page may talk to the database
        try
        {
            var reply = await _bridge.HandleAsync(e.WebMessageAsJson);
            Web.CoreWebView2.PostWebMessageAsJson(reply);
        }
        catch (Exception ex)
        {
            // HandleAsync never throws; this only guards PostWebMessage while the window is closing.
            Debug.WriteLine($"Reply could not be delivered: {ex}");
        }
    }
}
