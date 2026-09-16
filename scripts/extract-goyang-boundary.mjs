import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const sourceUrl = 'https://raw.githubusercontent.com/southkorea/southkorea-maps/master/kostat/2018/json/skorea-municipalities-2018-geo.json'
const outputPath = resolve('public/data/goyang-boundary.json')
const goyangCodes = new Set(['31101', '31103', '31104'])

const response = await fetch(sourceUrl)
if (!response.ok) throw new Error(`경계 데이터를 내려받지 못했습니다: ${response.status}`)

const source = await response.json()
const features = source.features.filter((feature) => goyangCodes.has(String(feature.properties?.code)))
if (features.length !== goyangCodes.size) throw new Error(`고양시 경계 3개 중 ${features.length}개만 찾았습니다.`)

const boundary = {
  type: 'FeatureCollection',
  name: '고양시 행정구역 경계',
  source: 'southkorea/southkorea-maps, KOSTAT 2018',
  sourceUrl,
  features,
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(boundary)}\n`, 'utf8')
console.log(`고양시 경계 ${features.length}개를 ${outputPath}에 저장했습니다.`)
