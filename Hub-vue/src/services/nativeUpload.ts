import type { UploadId, UploadFile, UploadRawFile, UploadOptions, UploadProgress, UploadResponse } from '@/types/upload'

export interface UploadControllerOptions {
  getFiles: () => UploadFile[]
  setFiles: (files: UploadFile[]) => void
  request: (options: UploadOptions) => Promise<UploadResponse>
  abort: (uid: UploadId) => void
  beforeUpload?: (file: UploadRawFile) => boolean | Promise<boolean>
  disabled?: () => boolean
  preview?: boolean
  limit?: number
  onChange?: (file: UploadFile | undefined, files: UploadFile[]) => void
  onSuccess?: (response: UploadResponse, file: UploadFile, files: UploadFile[]) => void
  onError?: (error: unknown, file: UploadFile, files: UploadFile[]) => void
  onProgress?: (event: UploadProgress, file: UploadFile) => void
  onRemove?: (file: UploadFile) => void
}
import { releaseImagePreview } from '@/utils/imageUpload';
let sequence = 0;
// 移除文件或离开页面后忽略迟到的上传回调。
export const createUploadController = ({
  getFiles,
  setFiles,
  request,
  abort,
  beforeUpload = () => true,
  disabled = () => false,
  preview = false,
  limit = 0,
  onChange = () => {},
  onSuccess = () => {},
  onError = () => {},
  onProgress = () => {},
  onRemove = () => {}
}: UploadControllerOptions) => {
  let disposed = false;
  const running = new Map<UploadId, object>();
  const present = (file: UploadFile) => !disposed && getFiles().some(item => item.uid === file.uid);
  const update = (files: UploadFile[]) => {
    setFiles(files);
    onChange(files[files.length - 1], files);
  };
  const remove = (file: UploadFile) => {
    running.delete(file.uid);
    abort(file.uid);
    releaseImagePreview(file);
    update(getFiles().filter(item => item.uid !== file.uid));
    onRemove(file);
  };
  const start = async (file: UploadFile) => {
    file = getFiles().find(item => item.uid === file.uid) || file;
    if (!present(file) || file.status !== 'ready' || !file.raw || running.has(file.uid)) return;
    const operation = {};
    running.set(file.uid, operation);
    const current = () => present(file) && running.get(file.uid) === operation;
    try {
      const accepted = await beforeUpload(file.raw);
      if (!current()) return;
      if (!accepted) {
        remove(file);
        return;
      }
      if (preview && !file.url) file.url = URL.createObjectURL(file.raw);
      file.status = 'uploading';
      const result = await request({
        file: file.raw,
        filename: 'file',
        onProgress: event => {
          if (current()) {
            file.percentage = event.percent || 0;
            onProgress(event, file);
          }
        }
      });
      if (!current()) return;
      file.status = 'success';
      file.percentage = 100;
      onSuccess(result, file, getFiles());
    } catch (error) {
      if (!current()) return;
      file.status = 'fail';
      onError(error, file, getFiles());
      releaseImagePreview(file);
      setFiles(getFiles().filter(item => item.uid !== file.uid));
    } finally {
      if (running.get(file.uid) === operation) running.delete(file.uid);
    }
  };
  const select = (rawFiles: ArrayLike<UploadRawFile>) => {
    if (disposed || disabled()) return [];
    const capacity = limit ? Math.max(0, limit - getFiles().length) : rawFiles.length;
    const added = Array.from(rawFiles).slice(0, capacity).map(raw => {
      const uid = 'file-' + Date.now() + '-' + ++sequence;
      raw.uid = uid;
      return {
        uid,
        name: raw.name,
        size: raw.size,
        raw,
        status: 'ready' as const,
        percentage: 0
      };
    });
    update([...getFiles(), ...added]);
    return added.map(start);
  };
  const submit = () => getFiles().filter(file => file.status === 'ready').map(start);
  const clearFiles = () => {
    for (const file of getFiles()) {
      running.delete(file.uid);
      abort(file.uid);
      releaseImagePreview(file);
    }
    setFiles([]);
  };
  const dispose = () => {
    disposed = true;
    clearFiles();
  };
  return {
    select,
    submit,
    remove,
    clearFiles,
    dispose
  };
};
