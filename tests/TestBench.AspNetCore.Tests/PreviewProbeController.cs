using Microsoft.AspNetCore.Mvc;

namespace TestBench.AspNetCore.Tests;

[ApiController]
[Route("mvc/action")]
public sealed class PreviewProbeController : ControllerBase
{
    [HttpGet("{id:guid}")]
    [TestBenchPreview]
    public IActionResult Read(Guid id, [FromServices] TestBenchPreview preview) => Ok(new { id, isPreview = preview.IsActive });

    [HttpGet("unmarked")]
    public IActionResult Unmarked() => NoContent();
}

[ApiController]
[Route("mvc/controller")]
[TestBenchPreview]
public sealed class PreviewControllerProbeController : ControllerBase
{
    [HttpGet("{id:guid}")]
    public IActionResult Read(Guid id, [FromServices] TestBenchPreview preview) => Ok(new { id, isPreview = preview.IsActive });
}
