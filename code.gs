function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
      .setTitle('麻雀点数計算機')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
