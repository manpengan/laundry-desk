import { useEffect, useMemo, useState } from "react";

import type { PhotoPort, PhotoReadVariant } from "../host/photo-port.js";
import type { PhotoMetaRow } from "./photo-list.js";
import type { OrderGetGarment } from "./order-form.js";
import { photoGarmentLabel, photoKindLabel } from "./order-photo-labels.js";
import { PhotoViewer } from "./PhotoViewer.js";

type ImageState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error"; message: string }>
  | Readonly<{ status: "ready"; url: string; onError: () => void }>;

function usePhotoUrl(
  photoPort: PhotoPort | undefined,
  photoId: string,
  variant: PhotoReadVariant,
  retry: number,
): ImageState {
  const request = useMemo(
    () => ({ photoPort, photoId, variant, retry }),
    [photoPort, photoId, variant, retry],
  );
  const [snapshot, setSnapshot] = useState<Readonly<{
    request: typeof request;
    state: ImageState;
  }> | null>(null);
  useEffect(() => {
    const { photoPort, photoId, variant } = request;
    let cancelled = false;
    let objectUrl: string | null = null;
    const setState = (state: ImageState) => {
      if (!cancelled) setSnapshot({ request, state });
    };
    setState({ status: "loading" });
    if (photoPort === undefined) {
      setState({ status: "error", message: "照片预览不可用" });
      return;
    }
    void photoPort.read(photoId, variant).then(
      (result) => {
        if (cancelled) return;
        if (!result.ok) {
          setState({
            status: "error",
            message: result.error.message ?? result.error.code,
          });
          return;
        }
        objectUrl = URL.createObjectURL(
          new Blob([Uint8Array.from(result.data.bytes)], {
            type: result.data.content_type,
          }),
        );
        setState({
          status: "ready",
          url: objectUrl,
          onError: () => setState({ status: "error", message: "照片显示失败，请重试" }),
        });
      },
      () => {
        if (!cancelled) setState({ status: "error", message: "照片读取失败" });
      },
    );
    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [request]);
  return snapshot?.request === request ? snapshot.state : { status: "loading" };
}

function PhotoImage({
  photo,
  photoPort,
  variant,
  onOpen,
}: Readonly<{
  photo: PhotoMetaRow;
  photoPort: PhotoPort | undefined;
  variant: PhotoReadVariant;
  onOpen?: () => void;
}>) {
  const [retry, setRetry] = useState(0);
  const state = usePhotoUrl(photoPort, photo.photo_id, variant, retry);
  if (state.status === "loading") {
    return <span className="ld-photo-image__status">加载中…</span>;
  }
  if (state.status === "error") {
    return (
      <span className="ld-photo-image__error" role="alert">
        <span>{state.message}</span>
        <button type="button" onClick={() => setRetry((value) => value + 1)}>
          重试
        </button>
      </span>
    );
  }
  return onOpen === undefined ? (
    <img src={state.url} alt={`${photoKindLabel(photo.kind)} 照片`} onError={state.onError} />
  ) : (
    <button type="button" className="ld-photo-image__open" onClick={onOpen}>
      <img
        src={state.url}
        alt={`${photoKindLabel(photo.kind)} 照片缩略图`}
        onError={state.onError}
      />
    </button>
  );
}

export function PhotoGallery({
  photos,
  garments = [],
  photoPort,
  onDelete,
}: Readonly<{
  photos: readonly PhotoMetaRow[];
  garments?: readonly OrderGetGarment[];
  photoPort?: PhotoPort;
  onDelete?: (photoId: string) => Promise<boolean>;
}>) {
  const [selected, setSelected] = useState<PhotoMetaRow | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const garmentLabel = (photo: PhotoMetaRow) => {
    const garment = garments.find((item) => item.garment_id === photo.garment_id);
    return garment === undefined ? "衣物信息暂不可用" : photoGarmentLabel(garment);
  };
  const visibleSelected =
    selected === null
      ? null
      : (photos.find((photo) => photo.photo_id === selected.photo_id) ?? null);

  const closeViewer = () => {
    if (deleteBusy) return;
    setSelected(null);
    setConfirmingDelete(false);
  };

  const deleteSelected = async () => {
    if (selected === null || onDelete === undefined || deleteBusy) return;
    setDeleteBusy(true);
    try {
      if (await onDelete(selected.photo_id)) {
        setSelected(null);
        setConfirmingDelete(false);
      }
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <>
      <ul className="ld-order-detail__photo-list">
        {photos.map((photo) => (
          <li
            key={photo.photo_id}
            className="ld-order-detail__photo-thumb"
            data-testid="order-detail-photo-thumb"
            title={`${garmentLabel(photo)} / ${photoKindLabel(photo.kind)}`}
          >
            <PhotoImage
              photo={photo}
              photoPort={photoPort}
              variant="thumbnail"
              onOpen={() => setSelected(photo)}
            />
            <span className="ld-order-detail__photo-kind">{photoKindLabel(photo.kind)}</span>
            <span>{garmentLabel(photo)}</span>
            <span className="ld-order-detail__photo-bytes">{photo.byte_size} B</span>
          </li>
        ))}
      </ul>
      {visibleSelected !== null ? (
        <PhotoViewer onClose={closeViewer}>
          <p>
            {garmentLabel(visibleSelected)} / {photoKindLabel(visibleSelected.kind)}
          </p>
          <PhotoImage photo={visibleSelected} photoPort={photoPort} variant="original" />
          <div className="ld-photo-viewer__actions">
            {onDelete !== undefined ? (
              confirmingDelete ? (
                <div className="ld-photo-viewer__confirm" role="alert">
                  <span>删除后不可恢复，确认删除？</span>
                  <button type="button" disabled={deleteBusy} onClick={() => void deleteSelected()}>
                    {deleteBusy ? "删除中…" : "确认删除"}
                  </button>
                  <button
                    type="button"
                    disabled={deleteBusy}
                    onClick={() => setConfirmingDelete(false)}
                  >
                    取消
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => setConfirmingDelete(true)}>
                  删除照片
                </button>
              )
            ) : null}
            <button
              type="button"
              className="ld-photo-viewer__close"
              disabled={deleteBusy}
              data-autofocus=""
              onClick={closeViewer}
            >
              关闭照片
            </button>
          </div>
        </PhotoViewer>
      ) : null}
    </>
  );
}
