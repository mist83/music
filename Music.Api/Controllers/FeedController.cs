using Microsoft.AspNetCore.Mvc;
using Music.Api.Services;

namespace Music.Api.Controllers;

/// <summary>
/// music.mullmania.com — set a v3 source to /feed?filter1=a&amp;filter2=b and the app
/// parses the master with the data-tools music pack and returns a v3 display feed.
/// </summary>
[ApiController]
[Route("")]
public sealed class FeedController : ControllerBase
{
    private readonly MusicCatalog _catalog;
    public FeedController(MusicCatalog catalog) => _catalog = catalog;

    /// <summary>Filtered v3 feed. Filters: genre, decade (e.g. 1990), role (e.g. producer), artist, label, type, q, limit.</summary>
    [HttpGet("feed")]
    public IActionResult Feed(
        [FromQuery] string? genre, [FromQuery] string? decade, [FromQuery] string? role,
        [FromQuery] string? artist, [FromQuery] string? label, [FromQuery] string? type,
        [FromQuery] string? q, [FromQuery] int? limit) =>
        Ok(_catalog.BuildFeed(new FilterQuery(genre, decade, role, artist, label, type, q, limit ?? 200)));

    /// <summary>Master counts + provenance + the data-tools pack this app loaded.</summary>
    [HttpGet("stats")]
    public IActionResult Stats() => Ok(_catalog.Stats());

    /// <summary>Validate the master against the data-tools music pack (cross-reference integrity).</summary>
    [HttpGet("validate")]
    public IActionResult Validate()
    {
        var r = _catalog.Validate();
        return Ok(new
        {
            conforms = r.Errors == 0,
            errors = r.Errors,
            warnings = r.Warnings,
            info = r.Info,
            sample = r.Findings.Take(25).Select(f => new { f.RuleId, f.Severity, f.Row, f.Message })
        });
    }
}
