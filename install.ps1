# install.ps1 — 把 dispatch 工作流部署到本机 ~/.claude
#
# 仓库是唯一真源:改工作流 = 改仓库文件 → 重跑本脚本。
# 部署时把文本文件里的硬编码用户目录 C:\Users\nigo 替换为当前机器的 $env:USERPROFILE,
# 换机器可直接用(codex-companion 插件版本号路径除外,见 README)。

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$claude = Join-Path $env:USERPROFILE '.claude'
$origUser = 'C:\Users\nigo'

function Deploy-Text($src, $dst) {
    $content = Get-Content -Raw $src
    if ($env:USERPROFILE -ne $origUser) {
        $content = $content.Replace($origUser, $env:USERPROFILE)
    }
    New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
    Set-Content -NoNewline -Path $dst -Value $content
    Write-Host "deployed: $dst"
}

Deploy-Text "$repo\skills\dispatch\SKILL.md" "$claude\skills\dispatch\SKILL.md"
Deploy-Text "$repo\scripts\lane.mjs"        "$claude\lane.mjs"
Deploy-Text "$repo\scripts\codex-wait.mjs"  "$claude\codex-wait.mjs"
Deploy-Text "$repo\scripts\mutate.mjs"      "$claude\mutate.mjs"

# 全局 CLAUDE.md 不自动合并(内含其他手写内容)。首次安装:把 global\CLAUDE.md.section.md
# 的「## 开发模式」节粘进 ~/.claude/CLAUDE.md;之后若该节有更新,这里提示 diff。
$section = "$repo\global\CLAUDE.md.section.md"
$globalMd = "$claude\CLAUDE.md"
if (Test-Path $globalMd) {
    $head = (Get-Content $section | Select-String -Pattern '^## ' | Select-Object -First 1).Line
    if ($head -and -not (Select-String -Quiet -SimpleMatch -Pattern $head -Path $globalMd)) {
        Write-Warning "全局 CLAUDE.md 缺少「$head」节——请手动把 global\CLAUDE.md.section.md 粘进去"
    } else {
        Write-Host "global CLAUDE.md 已含开发模式节(如仓库侧有改动请手动同步)"
    }
} else {
    Write-Warning "未找到 $globalMd——新机器?把 global\CLAUDE.md.section.md 作为起点创建它"
}

Write-Host "`n完成。冒烟:node `"$claude\lane.mjs`" list(在任意 git 仓库内)"
