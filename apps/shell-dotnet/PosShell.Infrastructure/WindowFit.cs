namespace PosShell.Infrastructure;

/// <summary>A rectangle in device-independent pixels (what WPF uses for window sizes and positions).</summary>
public readonly record struct Box(double Left, double Top, double Width, double Height);

/// <summary>
/// Works out where a window opens so that it is always fully on screen. A fixed 1280x800 window centred with
/// CenterScreen opens with its top above the screen on a 1366x768 laptop or a display scaled to 125-150 %: the title
/// bar (minimize / maximize / close) and the header are cut off. No WPF types here, so it can be unit tested.
/// </summary>
public static class WindowFit
{
    /// <summary>Most of the work area a window may take, so a sliver of desktop always stays around it.</summary>
    public const double Fill = 0.96;

    /// <summary>
    /// The wanted size, shrunk to fit inside <paramref name="workArea"/> (the screen without the taskbar) and centred in it.
    /// The minimum size is respected unless the work area itself is smaller: the screen always wins.
    /// </summary>
    public static Box Fit(double wantedWidth, double wantedHeight, Box workArea, double minWidth, double minHeight)
    {
        var width = Fit1(wantedWidth, minWidth, workArea.Width);
        var height = Fit1(wantedHeight, minHeight, workArea.Height);
        return new Box(
            workArea.Left + (workArea.Width - width) / 2,
            workArea.Top + (workArea.Height - height) / 2,
            width,
            height);
    }

    private static double Fit1(double wanted, double min, double available)
    {
        var size = Math.Min(wanted, available * Fill);
        size = Math.Max(size, min);
        return Math.Min(size, available);
    }
}
