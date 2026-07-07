param(
  [Parameter(Mandatory = $true)][string]$Title,
  [string]$Body = ''
)
# WinRT API で Windows トースト通知を出す(モジュール不要、Windows PowerShell 5.1 対応)
try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

  function Esc([string]$s) {
    ($s -replace '&', '&amp;') -replace '<', '&lt;' -replace '>', '&gt;'
  }

  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml("<toast><visual><binding template=""ToastGeneric""><text>$(Esc $Title)</text><text>$(Esc $Body)</text></binding></visual></toast>")

  # 未登録 AppId ではトーストが表示されないため、登録済みの PowerShell の AppId を借りる
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  $toast = New-Object Windows.UI.Notifications.ToastNotification($xml)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
