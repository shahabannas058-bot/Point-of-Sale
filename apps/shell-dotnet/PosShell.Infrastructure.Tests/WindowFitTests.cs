using Xunit;

namespace PosShell.Infrastructure.Tests;

/// <summary>
/// The window must always open fully on screen, so its title bar (minimize / maximize / close) and the header are
/// never cut off, whatever the screen size or display scaling.
/// </summary>
public class WindowFitTests
{
    private static void AssertInside(Box w, Box area)
    {
        Assert.True(w.Left >= area.Left - 0.001, $"left {w.Left} < {area.Left}");
        Assert.True(w.Top >= area.Top - 0.001, $"top {w.Top} < {area.Top}");
        Assert.True(w.Left + w.Width <= area.Left + area.Width + 0.001, "right edge is off screen");
        Assert.True(w.Top + w.Height <= area.Top + area.Height + 0.001, "bottom edge is off screen");
    }

    [Fact]
    public void A_big_screen_keeps_the_wanted_size_and_centres_the_window()
    {
        var area = new Box(0, 0, 1920, 1040);
        var w = WindowFit.Fit(1280, 800, area, minWidth: 360, minHeight: 480);

        Assert.Equal(1280, w.Width);
        Assert.Equal(800, w.Height);
        Assert.Equal(320, w.Left);
        Assert.Equal(120, w.Top);
    }

    [Fact]
    public void A_short_laptop_screen_shrinks_the_height_so_the_title_bar_stays_visible()
    {
        // 1366x768 minus the taskbar: 728 high. The old fixed 800 high window opened with its top above the screen.
        var area = new Box(0, 0, 1366, 728);
        var w = WindowFit.Fit(1280, 800, area, minWidth: 360, minHeight: 480);

        Assert.True(w.Height < 728);
        Assert.True(w.Top >= 0);
        AssertInside(w, area);
    }

    [Fact]
    public void A_screen_scaled_to_150_percent_is_handled_the_same_way()
    {
        // 1920x1080 at 150 % is 1280x720 device-independent pixels, minus a 40 px taskbar
        var area = new Box(0, 0, 1280, 680);
        var w = WindowFit.Fit(1280, 800, area, minWidth: 360, minHeight: 480);

        AssertInside(w, area);
        Assert.True(w.Width < 1280);
        Assert.True(w.Height < 680);
    }

    [Fact]
    public void A_taskbar_on_top_or_a_second_monitor_offset_is_respected()
    {
        var top = new Box(0, 40, 1920, 1040);
        AssertInside(WindowFit.Fit(1280, 800, top, 360, 480), top);

        var second = new Box(-1920, -200, 1920, 1040); // a monitor to the left and above the primary one
        AssertInside(WindowFit.Fit(1280, 800, second, 360, 480), second);
    }

    [Fact]
    public void A_tiny_work_area_wins_over_the_minimum_size()
    {
        var area = new Box(0, 0, 320, 400);
        var w = WindowFit.Fit(1280, 800, area, minWidth: 360, minHeight: 480);

        AssertInside(w, area);
    }

    [Fact]
    public void The_wanted_size_is_never_made_bigger()
    {
        var area = new Box(0, 0, 1920, 1040);
        var w = WindowFit.Fit(800, 600, area, minWidth: 360, minHeight: 480);

        Assert.Equal(800, w.Width);
        Assert.Equal(600, w.Height);
    }

    [Theory]
    [InlineData(1024, 600)]
    [InlineData(1280, 720)]
    [InlineData(1366, 728)]
    [InlineData(1536, 824)]
    [InlineData(1920, 1040)]
    [InlineData(2560, 1400)]
    [InlineData(800, 560)]
    public void The_window_is_always_fully_on_screen(double width, double height)
    {
        var area = new Box(0, 0, width, height);
        AssertInside(WindowFit.Fit(1280, 800, area, minWidth: 360, minHeight: 480), area);
    }
}
