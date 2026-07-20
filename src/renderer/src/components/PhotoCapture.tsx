import React, { useRef, useState } from "react";
import { Camera, Upload, X } from "lucide-react";
import { Button } from "./ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/Card";

interface PhotoCaptureProps {
  photos: string[];
  onChange: (photos: string[]) => void;
}

export function PhotoCapture({ photos, onChange }: PhotoCaptureProps) {
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const startCamera = async () => {
    setIsCameraOpen(true);
    setErrorMsg("");
    setTimeout(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch (err) {
        console.error("无法启动摄像头:", err);
        setErrorMsg("无法访问摄像头，请检查设备权限或使用文件上传功能");
        setIsCameraOpen(false);
      }
    }, 100);
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsCameraOpen(false);
  };

  const takeSnapshot = () => {
    if (videoRef.current) {
      const canvas = document.createElement("canvas");
      canvas.width = videoRef.current.videoWidth || 640;
      canvas.height = videoRef.current.videoHeight || 480;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
        onChange([...photos, dataUrl].slice(0, 4));
      }
    }
    stopCamera();
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files) {
      Array.from(files).forEach((file) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          if (typeof reader.result === "string") {
            onChange([...photos, reader.result as string].slice(0, 4));
          }
        };
        reader.readAsDataURL(file);
      });
    }
  };

  const removePhoto = (idx: number) => {
    onChange(photos.filter((_, i) => i !== idx));
  };

  return (
    <>
      <Card className="border-none shadow-sm">
        <CardHeader>
          <CardTitle className="text-base flex items-center justify-between">
            <span>衣物留样照片</span>
            <span className="text-xs font-normal text-slate-400">
              最多 4 张
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {photos.map((photo, idx) => (
              <div
                key={idx}
                className="relative aspect-square rounded-xl overflow-hidden border border-slate-100 group bg-slate-50"
              >
                <img src={photo} className="w-full h-full object-cover" />
                <button
                  type="button"
                  onClick={() => removePhoto(idx)}
                  className="absolute top-1.5 right-1.5 p-1 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1 text-xs"
              onClick={startCamera}
              disabled={photos.length >= 4}
            >
              <Camera className="w-4 h-4 mr-1.5" /> 拍摄照片
            </Button>
            <Button
              type="button"
              variant="outline"
              className="flex-1 text-xs"
              onClick={() => fileInputRef.current?.click()}
              disabled={photos.length >= 4}
            >
              <Upload className="w-4 h-4 mr-1.5" /> 上传照片
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
          {errorMsg && (
            <div className="text-xs text-red-500 mt-1">{errorMsg}</div>
          )}
        </CardContent>
      </Card>

      {isCameraOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-md">
          <div className="bg-white rounded-3xl p-6 max-w-md w-full shadow-2xl border border-white/40 space-y-4">
            <h3 className="text-lg font-bold">拍摄衣物留样</h3>
            <div className="relative aspect-video bg-black rounded-2xl overflow-hidden">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                className="w-full h-full object-cover"
              />
            </div>
            <div className="flex gap-3 justify-end">
              <Button variant="ghost" onClick={stopCamera}>
                取消
              </Button>
              <Button onClick={takeSnapshot}>
                <Camera className="w-4 h-4 mr-2" /> 拍照截图
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
