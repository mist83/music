using Amazon.Lambda.AspNetCoreServer.Hosting;
using Music.Api.Services;

var builder = WebApplication.CreateBuilder(args);

// The same ASP.NET Core app runs as an AWS Lambda behind a Function URL (no-op locally).
// This is the canonical fleet backend shape (ineed: "serverless compute -> Lambda + Function URL").
builder.Services.AddAWSLambdaHosting(LambdaEventSource.HttpApi);

builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(c => c.SwaggerDoc("v1", new Microsoft.OpenApi.Models.OpenApiInfo
{
    Title = "music.mullmania.com",
    Version = "v1",
    Description = "Parses music.master.v1 with the data-tools 'music' pack and serves filtered v3 display feeds."
}));

// Load the master + the data-tools music pack once at startup.
builder.Services.AddSingleton(_ => MusicCatalog.Load(
    masterPath: Resolve("MUSIC_MASTER_PATH", "music-master.json", Path.Combine("..", "data", "music-master.json")),
    packsDir: ResolveDir("MUSIC_PACKS_PATH", "packs", Path.Combine("..", "spec"))));

var app = builder.Build();
// CORS is owned by the Lambda Function URL config (lambda-deploy.json), not the app —
// having both emits duplicate Access-Control-Allow-Origin headers, which browsers reject.
app.UseSwagger();
app.UseSwaggerUI();
app.MapControllers();
app.MapGet("/", () => Results.Redirect("/swagger"));
app.Run();

// Resolve a file: env override -> next to the app -> dev layout. Mirrors HostBootstrap.
static string Resolve(string env, params string[] candidates)
{
    var fromEnv = Environment.GetEnvironmentVariable(env);
    if (!string.IsNullOrWhiteSpace(fromEnv) && File.Exists(fromEnv)) return fromEnv;
    var baseDir = AppContext.BaseDirectory;
    foreach (var c in candidates)
    {
        var p = Path.GetFullPath(Path.Combine(baseDir, c));
        if (File.Exists(p)) return p;
    }
    return candidates.Length > 0 ? Path.GetFullPath(Path.Combine(baseDir, candidates[0])) : "";
}

static string ResolveDir(string env, params string[] candidates)
{
    var fromEnv = Environment.GetEnvironmentVariable(env);
    if (!string.IsNullOrWhiteSpace(fromEnv) && Directory.Exists(fromEnv)) return fromEnv;
    var baseDir = AppContext.BaseDirectory;
    foreach (var c in candidates)
    {
        var p = Path.GetFullPath(Path.Combine(baseDir, c));
        if (Directory.Exists(p)) return p;
    }
    return candidates.Length > 0 ? Path.GetFullPath(Path.Combine(baseDir, candidates[0])) : "";
}

public partial class Program { }
