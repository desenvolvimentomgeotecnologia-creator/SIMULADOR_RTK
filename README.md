# MGEO · Simulador de Cobertura RTK 450 MHz

Simulador web de cobertura de sinal de rádio RTK (UHF 450 MHz) usando a altimetria do terreno (SRTM).
Funciona no computador e no celular (pode ser instalado como app pela opção "Adicionar à tela inicial").

## Funções
- Clique/toque no mapa para posicionar a base; cobertura em 3 níveis (bom / médio / ruim) + área sem sinal
- Perfil do terreno base → rover com zona de Fresnel
- Sugestão automática de repetidoras (onde instalar para recuperar área sem sinal)
- Consulta de sinal em um ponto e na posição do GPS do celular
- Exportação: Relatório PDF com logo MGEO, KMZ (Google Earth) e PNG georreferenciado (QGIS/ArcGIS)

## Publicar no GitHub Pages
1. Crie um repositório no GitHub (ex.: `simulador-rtk`), público.
2. Clique em **Add file → Upload files** e arraste **todo o conteúdo desta pasta** (index.html, js/, assets/, manifest.webmanifest, sw.js, .nojekyll, README.md). Clique em **Commit changes**.
3. Vá em **Settings → Pages**. Em *Build and deployment*, escolha **Deploy from a branch**, branch **main**, pasta **/(root)** e clique em **Save**.
4. Em 1–2 minutos o site estará em `https://SEU-USUARIO.github.io/simulador-rtk/`.

Para atualizar: envie os arquivos novos pelo mesmo "Upload files" (substituem os antigos).

## Observações
- Altimetria: AWS Terrain Tiles (SRTM ~30 m). Satélite: Google / Esri.
- O GPS do celular só funciona com o site em HTTPS (GitHub Pages já é HTTPS).
- Resultados são estimativas — calibre a "perda por vegetação" com medições de campo.
