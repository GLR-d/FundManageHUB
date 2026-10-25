export const MAX_UPLOAD_BYTES = 1024 * 1024
const MAX_SOURCE_BYTES = 20 * MAX_UPLOAD_BYTES
export const getImageUploadError = (file: Pick<File, 'type' | 'size'>) => {
  if (!['image/jpeg', 'image/png'].includes(file.type)) return '请上传 JPG/PNG 格式的图片'
  if (file.size > MAX_SOURCE_BYTES) return '图片大小不能超过 20MB'
  return ''
}
export const releaseImagePreview = (file: { url?: string } | null | undefined) => {
  if (file?.url?.startsWith('blob:')) URL.revokeObjectURL(file.url)
}
const checkCanceled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw Object.assign(new Error('图片上传已取消'), { code: 'ERR_CANCELED', __CANCEL__: true })
}
const decodeImage = async (file: File): Promise<HTMLImageElement | ImageBitmap> => {
  if (typeof createImageBitmap === 'function') return createImageBitmap(file)
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('图片无法读取'))
      image.src = url
    })
  } finally { URL.revokeObjectURL(url) }
}
// 只处理超过服务端大小限制的图片；PNG 仍输出 PNG，保留透明背景。
export const compressUploadImage = async (file: File, signal?: AbortSignal, environment = { decodeImage, createCanvas: () => document.createElement('canvas') }) => {
  checkCanceled(signal)
  const validationError = getImageUploadError(file)
  if (validationError) throw new Error(validationError)
  if (file.size <= MAX_UPLOAD_BYTES) return file
  let image: HTMLImageElement | ImageBitmap | undefined
  let canvas: HTMLCanvasElement | undefined
  try {
    image = await environment.decodeImage(file)
    checkCanceled(signal)
    const width = image.width || ('naturalWidth' in image ? image.naturalWidth : 0)
    const height = image.height || ('naturalHeight' in image ? image.naturalHeight : 0)
    if (!width || !height) throw new Error('图片尺寸无效')
    canvas = environment.createCanvas()
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器不支持图片处理')
    let scale = Math.min(1, 2560 / Math.max(width, height))
    for (let attempt = 0; attempt < 8; attempt++) {
      checkCanceled(signal)
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>(resolve => canvas!.toBlob(resolve, file.type, attempt === 0 ? 0.86 : 0.76))
      checkCanceled(signal)
      if (!blob) throw new Error('图片编码失败')
      if (blob.size <= MAX_UPLOAD_BYTES) return new File([blob], file.name, { type: file.type, lastModified: file.lastModified })
      scale *= 0.75
    }
    throw new Error('图片仍然过大')
  } catch (error) {
    checkCanceled(signal)
    throw new Error('图片压缩失败，请尝试较小的 JPG/PNG 图片', { cause: error })
  } finally {
    if (image && 'close' in image) image.close()
    if (canvas) { canvas.width = 0; canvas.height = 0 }
  }
}
