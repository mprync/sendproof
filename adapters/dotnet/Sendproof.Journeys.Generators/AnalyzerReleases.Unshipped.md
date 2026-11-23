; Unshipped analyzer release
; https://github.com/dotnet/roslyn-analyzers/blob/main/src/Microsoft.CodeAnalysis.Analyzers/ReleaseTrackingAnalyzers.Help.md

### New Rules

Rule ID | Category | Severity | Notes
--------|----------|----------|-------
SPJ001 | Sendproof.Journeys | Warning | An endpoint without WithName has no OpenAPI operationId
SPJ002 | Sendproof.Journeys | Warning | Two operations map to one catalog name
