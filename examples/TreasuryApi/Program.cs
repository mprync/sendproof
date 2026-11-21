using TreasuryApi;

var builder = WebApplication.CreateBuilder(args);
var app = await TreasuryApplication.BuildAsync(builder);
app.Run();
