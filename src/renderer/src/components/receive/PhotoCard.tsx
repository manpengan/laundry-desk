import { useRef, useState } from "react";
import { Camera, Upload, X } from "lucide-react";
import { Button } from "../ui/Button";

interface PhotoCardProps {
  photos: string[];
  onChange: (next: string[]) => void;
  onError: (message: string) => void;
}

export function PhotoCard({ photos, onChange, onError }: PhotoCardProps) {
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const startCamera = async (): Promise<void> => {
    setIsCameraOpen(true);
    setTimeout(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch (err) {
        console.error("无法启动摄像头:", err);
        onError("无法访问摄像头，请检查设备权限或使用文件上传功能");
        setIsCameraOpen(false);
      }
    }, 100);
  };

  const stopCamera = (): void => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setIsCameraOpen(false);
  };

  const takeSnapshot = (): void => {
    if (videoRef.current) {
      const canvas = document.createElement("canvas");
      canvas.width = videoRef.current.videoWidth || 640;
      canvas.height = videoRef.current.videoHeight || 480;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
        onChange([...photos, canvas.toDataURL("image/jpeg", 0.8)].slice(0, 4));
      }
    }
    stopCamera();
  };

  const handleFileChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ): void => {
    const files = event.target.files;
    if (!files) return;
    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === "string") {
          onChange([...photos, reader.result].slice(0, 4));
        }
      };
      reader.readAsDataURL(file);
    });
  };

  return (
    <div className="lg-card lg-spec rounded-[20px]">
      <div className="flex items-center justify-between px-5 pb-1 pt-4">
        <h3 className="text-[15px] font-semibold">衣物留样照片</h3>
        <span className="text-[11px] font-semibold text-[var(--lg-ink3)]">
          最多 4 张
        </span>
      </div>
      <div className="space-y-3 p-4 pt-2">
        {photos.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {photos.map((photo, idx) => (
              <div
                key={idx}
                className="lg-inset group relative aspect-square overflow-hidden rounded-[14px]"
              >
                <img src={photo} className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => onChange(photos.filter((_, i) => i !== idx))}
                  className="absolute right-1.5 top-1.5 rounded-full bg-black/55 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => void startCamera()}
            disabled={photos.length >= 4}
          >
            <Camera className="mr-1 h-3.5 w-3.5" /> 拍摄照片
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => fileInputRef.current?.click()}
            disabled={photos.length >= 4}
          >
            <Upload className="mr-1 h-3.5 w-3.5" /> 上传本地
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={handleFileChange}
          />
        </div>
      </div>

      {isCameraOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{
            background: "rgba(10,14,26,0.32)",
            backdropFilter: "blur(10px) saturate(1.2)",
          }}
        >
          <div className="lg-glass lg-spec w-full max-w-md space-y-4 rounded-[26px] p-6">
            <h3 className="text-[17px] font-bold tracking-[-0.01em]">
              拍摄衣物留样
            </h3>
            <div className="relative aspect-video overflow-hidden rounded-[16px] bg-black">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                className="h-full w-full object-cover"
              />
            </div>
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={stopCamera}>
                取消
              </Button>
              <Button onClick={takeSnapshot}>
                <Camera className="mr-2 h-4 w-4" /> 拍照截图
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
