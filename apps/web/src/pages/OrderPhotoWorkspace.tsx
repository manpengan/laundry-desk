import type { QueryPort } from "../commands/types.js";
import type { PhotoPort } from "../host/photo-port.js";
import { OrderPhotosPanel } from "./OrderPhotosPanel.js";
import { useOrderPhotos, type PhotoOrder } from "./use-order-photos.js";

type Props = Readonly<{ order: PhotoOrder; queryClient: QueryPort; photoPort?: PhotoPort }>;

/** Reusable after receiving an order or in its detail drawer; unsaved garments have no photo identity. */
export function OrderPhotoWorkspace(props: Props) {
  return <OrderPhotoWorkspaceForOrder key={props.order.order_id} {...props} />;
}

function OrderPhotoWorkspaceForOrder({ order, queryClient, photoPort }: Props) {
  const state = useOrderPhotos(order, queryClient, photoPort);
  return (
    <OrderPhotosPanel
      order={order}
      photos={state.photos}
      photoLoading={state.loading}
      photoError={state.error}
      onRetryPhotos={() => void state.reload()}
      registerBusy={state.busy}
      uploadError={state.failed?.message ?? null}
      {...(state.failed === null
        ? {}
        : {
            uploadTarget: state.failed.attempt.label,
            onRetryUpload: state.retry,
            onDiscardUpload: state.discardFailure,
          })}
      {...(photoPort === undefined
        ? {}
        : {
            photoPort,
            onRegisterPhoto: state.upload,
            onDeletePhoto: state.remove,
          })}
    />
  );
}
