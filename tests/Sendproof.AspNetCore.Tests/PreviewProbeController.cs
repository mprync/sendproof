using Microsoft.AspNetCore.Mvc;

namespace Sendproof.AspNetCore.Tests;

[ApiController]
[Route("mvc/action")]
public sealed class PreviewProbeController : ControllerBase
{
    [HttpGet("{id:guid}")]
    [SendproofPreview]
    public IActionResult Read(Guid id, [FromServices] SendproofPreview preview) => Ok(new { id, isPreview = preview.IsActive });

    [HttpGet("unmarked")]
    public IActionResult Unmarked() => NoContent();
}

[ApiController]
[Route("mvc/controller")]
[SendproofPreview]
public sealed class PreviewControllerProbeController : ControllerBase
{
    [HttpGet("{id:guid}")]
    public IActionResult Read(Guid id, [FromServices] SendproofPreview preview) => Ok(new { id, isPreview = preview.IsActive });
}
