using System.Text;
using System.Text.Json;
using DataTools.Packs;

namespace Music.Api.Services;

/// <summary>
/// Loads music.master.v1 and the data-tools "music" domain pack, then:
///   - validates the master against the pack (cross-reference integrity) via DataTools.Packs, and
///   - translates filtered slices of the master into v3 display feeds.
/// The pack load + validation is the genuine "use the data-tools libraries to parse it" core.
/// </summary>
public sealed class MusicCatalog
{
    private readonly JsonDocument _doc;
    private readonly DeclarativePackValidator _validator = new();

    public DomainPackSpec Pack { get; }
    public JsonElement Root => _doc.RootElement;

    private MusicCatalog(JsonDocument doc, DomainPackSpec pack)
    {
        _doc = doc;
        Pack = pack;
    }

    public static MusicCatalog Load(string masterPath, string packsDir)
    {
        var registry = new DomainPackRegistry();
        new DomainPackLoader().LoadDirectory(packsDir, registry);
        var pack = registry.Find("music")
            ?? throw new InvalidOperationException($"music pack not found in '{packsDir}'.");
        var doc = JsonDocument.Parse(File.ReadAllText(masterPath));
        return new MusicCatalog(doc, pack);
    }

    public JsonElement Collection(string path) =>
        Root.ValueKind == JsonValueKind.Object && Root.TryGetProperty(path, out var el) && el.ValueKind == JsonValueKind.Array
            ? el
            : default;

    // ---- validation: master vs the data-tools music pack ----------------------------------
    public ValidationReport Validate()
    {
        var related = new Dictionary<string, JsonElement>(StringComparer.OrdinalIgnoreCase);
        foreach (var c in Pack.Collections)
        {
            var el = Collection(c.Path);
            if (el.ValueKind == JsonValueKind.Array) related[c.Path] = el;
        }

        var findings = new List<PackFinding>();
        foreach (var c in Pack.Collections)
            if (related.TryGetValue(c.Path, out var data))
                findings.AddRange(_validator.Validate(c, data, related));

        int e = findings.Count(f => Sev(f, "Error"));
        int w = findings.Count(f => Sev(f, "Warning"));
        int i = findings.Count(f => Sev(f, "Info"));
        return new ValidationReport(e, w, i, findings);
    }

    private static bool Sev(PackFinding f, string s) => string.Equals(f.Severity, s, StringComparison.OrdinalIgnoreCase);

    public object Stats()
    {
        Root.TryGetProperty("counts", out var counts);
        Root.TryGetProperty("provenance", out var prov);
        return new
        {
            specVersion = Str(Root, "specVersion"),
            generatedAt = Str(Root, "generatedAt"),
            counts = counts.ValueKind == JsonValueKind.Object ? (object)counts : null,
            pack = new { id = Pack.Id, label = Pack.Label, collections = Pack.Collections.Select(c => c.Path) },
            provenance = prov.ValueKind == JsonValueKind.Object ? (object)prov : null
        };
    }

    // ---- translation: master slice -> v3 feed ---------------------------------------------
    public Feed BuildFeed(FilterQuery q)
    {
        var artistName = new Dictionary<string, string>(StringComparer.Ordinal);
        var artistGenres = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var a in Each(Collection("artists")))
        {
            var id = Str(a, "id");
            if (id == null) continue;
            artistName[id] = Str(a, "name") ?? id;
            artistGenres[id] = StrArray(a, "genreIds");
        }

        var genreLabel = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var g in Each(Collection("genres")))
        {
            var id = Str(g, "id");
            if (id != null) genreLabel[id] = Str(g, "label") ?? id;
        }

        var labelName = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var l in Each(Collection("labels")))
        {
            var id = Str(l, "id");
            if (id != null) labelName[id] = Str(l, "name") ?? id;
        }

        if (!string.IsNullOrWhiteSpace(q.Role))
            return BuildRoleFeed(q, artistName, genreLabel);

        // Resolve the genre filter by label across both MB (slug ids) and FMA (genre:fma-N ids).
        HashSet<string>? wantGenreIds = null;
        if (!string.IsNullOrWhiteSpace(q.Genre))
        {
            var needle = q.Genre.Trim();
            var slugId = "genre:" + Slug(needle);
            wantGenreIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var kv in genreLabel)
                if (kv.Key.Equals(slugId, StringComparison.OrdinalIgnoreCase)
                    || kv.Value.Equals(needle, StringComparison.OrdinalIgnoreCase)
                    || kv.Value.Contains(needle, StringComparison.OrdinalIgnoreCase))
                    wantGenreIds.Add(kv.Key);
            if (wantGenreIds.Count == 0) wantGenreIds.Add(slugId);
        }
        var entries = new List<FeedEntry>();
        foreach (var r in Each(Collection("releases")))
        {
            var id = Str(r, "id");
            if (id == null) continue;
            var paId = Str(r, "primaryArtistId");
            var name = paId != null && artistName.TryGetValue(paId, out var n) ? n : "Unknown";
            var date = Str(r, "firstReleaseDate");
            var year = date is { Length: >= 4 } ? date[..4] : null;
            var type = Str(r, "type");
            var gids = StrArray(r, "genreIds");
            var lids = StrArray(r, "labelIds");

            if (wantGenreIds != null
                && !gids.Any(g => wantGenreIds.Contains(g))
                && !(paId != null && artistGenres.TryGetValue(paId, out var ag) && ag.Any(g => wantGenreIds.Contains(g))))
                continue;
            if (!string.IsNullOrWhiteSpace(q.Decade) && !InDecade(year, q.Decade)) continue;
            if (!string.IsNullOrWhiteSpace(q.Type) && !string.Equals(type, q.Type, StringComparison.OrdinalIgnoreCase)) continue;
            if (!string.IsNullOrWhiteSpace(q.Artist)
                && !name.Contains(q.Artist, StringComparison.OrdinalIgnoreCase)
                && !(paId?.Contains(q.Artist, StringComparison.OrdinalIgnoreCase) ?? false))
                continue;
            if (!string.IsNullOrWhiteSpace(q.Label)
                && !lids.Any(li => (labelName.TryGetValue(li, out var ln) && ln.Contains(q.Label, StringComparison.OrdinalIgnoreCase))
                                   || li.Contains(q.Label, StringComparison.OrdinalIgnoreCase)))
                continue;

            var title = Str(r, "title") ?? id;
            if (!string.IsNullOrWhiteSpace(q.Q)
                && !title.Contains(q.Q, StringComparison.OrdinalIgnoreCase)
                && !name.Contains(q.Q, StringComparison.OrdinalIgnoreCase))
                continue;

            var cover = CoverUrl(r) ?? GeneratedCover(title, name, id);
            var gLabels = gids.Select(gid => genreLabel.TryGetValue(gid, out var gl) ? gl : gid).Distinct().ToList();
            var desc = name + (year != null ? "  ·  " + year : "")
                            + (gLabels.Count > 0 ? "  ·  " + string.Join(", ", gLabels.Take(3)) : "");
            entries.Add(new FeedEntry(id, title, name, cover, cover, desc, year, type, gLabels));
            if (entries.Count >= Math.Max(1, q.Limit)) break;
        }

        var rows = new List<FeedRow>();
        foreach (var grp in entries.GroupBy(e => DecadeOf(e.Year)).OrderByDescending(g => g.Key, StringComparer.Ordinal))
            rows.Add(new FeedRow("decade:" + grp.Key, grp.Key == "Unknown" ? "Undated" : grp.Key + "s", "poster", grp.Select(e => e.Id).ToList()));
        if (rows.Count == 0) rows.Add(new FeedRow("all", "All", "poster", entries.Select(e => e.Id).ToList()));

        return Wrap(q, rows, entries);
    }

    private Feed BuildRoleFeed(FilterQuery q, Dictionary<string, string> artistName, Dictionary<string, string> genreLabel)
    {
        var role = q.Role!.Trim().ToLowerInvariant();
        var entries = new List<FeedEntry>();
        foreach (var a in Each(Collection("artists")))
        {
            var roles = StrArray(a, "roles");
            if (!roles.Any(r => string.Equals(r, role, StringComparison.OrdinalIgnoreCase))) continue;
            var id = Str(a, "id");
            if (id == null) continue;
            var name = Str(a, "name") ?? id;
            if (!string.IsNullOrWhiteSpace(q.Artist) && !name.Contains(q.Artist, StringComparison.OrdinalIgnoreCase)) continue;
            if (!string.IsNullOrWhiteSpace(q.Q) && !name.Contains(q.Q, StringComparison.OrdinalIgnoreCase)) continue;

            var img = ImageUrl(a) ?? GeneratedCover(name, Title(role), id);
            var gLabels = StrArray(a, "genreIds").Select(g => genreLabel.TryGetValue(g, out var gl) ? gl : g).Distinct().ToList();
            var bio = BioText(a);
            var desc = Title(role) + (gLabels.Count > 0 ? "  ·  " + string.Join(", ", gLabels.Take(3)) : "")
                                   + (bio != null ? "\n" + Truncate(bio, 220) : "");
            entries.Add(new FeedEntry(id, name, name, img, img, desc, null, Title(role), gLabels));
            if (entries.Count >= Math.Max(1, q.Limit)) break;
        }
        var rows = new List<FeedRow> { new("role:" + role, Title(role) + "s", "poster", entries.Select(e => e.Id).ToList()) };
        return Wrap(q, rows, entries);
    }

    private static Feed Wrap(FilterQuery q, List<FeedRow> rows, List<FeedEntry> entries) =>
        new("music.v3-feed.v1", DateTime.UtcNow.ToString("o"), "https://music.mullmania.com",
            new { q.Genre, q.Decade, q.Role, q.Artist, q.Label, q.Type, q.Q, q.Limit }, rows, entries);

    // ---- json helpers ----------------------------------------------------------------------
    private static IEnumerable<JsonElement> Each(JsonElement el)
    {
        if (el.ValueKind == JsonValueKind.Array)
            foreach (var x in el.EnumerateArray())
                yield return x;
    }

    private static string? Str(JsonElement o, string p) =>
        o.ValueKind == JsonValueKind.Object && o.TryGetProperty(p, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;

    private static List<string> StrArray(JsonElement o, string p)
    {
        var list = new List<string>();
        if (o.ValueKind == JsonValueKind.Object && o.TryGetProperty(p, out var v) && v.ValueKind == JsonValueKind.Array)
            foreach (var x in v.EnumerateArray())
                if (x.ValueKind == JsonValueKind.String) list.Add(x.GetString()!);
        return list;
    }

    private static string? CoverUrl(JsonElement r) =>
        r.TryGetProperty("coverImage", out var c) && c.ValueKind == JsonValueKind.Object ? Str(c, "url") : null;

    private static string? ImageUrl(JsonElement a) =>
        a.TryGetProperty("image", out var c) && c.ValueKind == JsonValueKind.Object ? Str(c, "url") : null;

    private static string? BioText(JsonElement a) =>
        a.TryGetProperty("bio", out var b) && b.ValueKind == JsonValueKind.Object ? Str(b, "text") : null;

    private static bool InDecade(string? year, string decade)
    {
        if (year == null || !int.TryParse(year, out var y)) return false;
        var d = new string(decade.Where(char.IsDigit).ToArray());
        if (!int.TryParse(d, out var start)) return false;
        start = start / 10 * 10;
        return y >= start && y <= start + 9;
    }

    private static string DecadeOf(string? year) =>
        year != null && int.TryParse(year, out var y) ? (y / 10 * 10).ToString() : "Unknown";

    private static string Slug(string s)
    {
        var sb = new StringBuilder();
        foreach (var ch in s.ToLowerInvariant())
            sb.Append(char.IsLetterOrDigit(ch) ? ch : '-');
        return sb.ToString().Trim('-');
    }

    private static string Title(string s) => s.Length == 0 ? s : char.ToUpperInvariant(s[0]) + s[1..];

    private static string Truncate(string s, int n) => s.Length <= n ? s : s[..n].TrimEnd() + "…";

    private static readonly string[] Palette =
        { "#0EA5E9", "#8B5CF6", "#EC4899", "#F97316", "#10B981", "#EF4444", "#6366F1", "#14B8A6", "#F59E0B", "#A855F7" };

    // Deterministic generated cover so every tile renders even when no real art exists.
    private static string GeneratedCover(string title, string subtitle, string seed)
    {
        int h = 0;
        foreach (var ch in seed) h = (h * 31 + ch) & 0x7fffffff;
        var bg = Palette[h % Palette.Length];
        var initials = string.Concat(title.Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Take(2).Select(w => char.ToUpperInvariant(w[0])));
        if (initials.Length == 0) initials = "♪";
        var svg =
            $"<svg xmlns='http://www.w3.org/2000/svg' width='500' height='500'>" +
            $"<rect width='500' height='500' fill='{bg}'/>" +
            $"<text x='50%' y='44%' font-family='system-ui,sans-serif' font-size='180' font-weight='700' fill='#FFFFFF' text-anchor='middle' dominant-baseline='central'>{Xml(initials)}</text>" +
            $"<text x='50%' y='74%' font-family='system-ui,sans-serif' font-size='30' fill='#FFFFFFCC' text-anchor='middle'>{Xml(Truncate(subtitle, 24))}</text>" +
            $"</svg>";
        return "data:image/svg+xml;base64," + Convert.ToBase64String(Encoding.UTF8.GetBytes(svg));
    }

    private static string Xml(string s) =>
        s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("'", "&apos;");
}

public sealed record FilterQuery(string? Genre, string? Decade, string? Role, string? Artist, string? Label, string? Type, string? Q, int Limit);

public sealed record Feed(string SpecVersion, string GeneratedAt, string Origin, object Filter, List<FeedRow> Rows, List<FeedEntry> Entries);

public sealed record FeedRow(string Id, string Title, string ShapeVariant, List<string> ItemIds);

public sealed record FeedEntry(string Id, string Title, string Artist, string PosterImage, string HeroImage, string Description, string? Year, string? Type, List<string> Genres);

public sealed record ValidationReport(int Errors, int Warnings, int Info, IReadOnlyList<PackFinding> Findings);
