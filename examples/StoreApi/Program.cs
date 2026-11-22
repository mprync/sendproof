using StoreApi;

var builder = WebApplication.CreateBuilder(args);
var app = await StoreApplication.BuildAsync(builder);
app.Run();
