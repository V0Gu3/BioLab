param(
  [Parameter(Mandatory = $true)]
  [string[]]$DocumentPaths,
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0

try {
  foreach ($documentPath in $DocumentPaths) {
    $resolvedDocument = [System.IO.Path]::GetFullPath($documentPath)
    if (-not [System.IO.File]::Exists($resolvedDocument)) {
      throw "No existe el documento: $resolvedDocument"
    }
    $document = $word.Documents.Open($resolvedDocument, $false, $false)
    try {
      foreach ($toc in $document.TablesOfContents) { $toc.Update() }
      $document.Fields.Update() | Out-Null
      $document.Save()
      $pdfName = [System.IO.Path]::GetFileNameWithoutExtension($resolvedDocument) + '.pdf'
      $pdfPath = [System.IO.Path]::Combine($resolvedOutput, $pdfName)
      $document.ExportAsFixedFormat($pdfPath, 17)
      Write-Output $pdfPath
    }
    finally {
      $document.Close($false)
      [System.Runtime.InteropServices.Marshal]::ReleaseComObject($document) | Out-Null
    }
  }
}
finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
