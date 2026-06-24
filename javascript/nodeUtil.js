import { app } from "../../scripts/app.js"


if (!('MovingWidgets' in window)) {
    window.MovingWidgets = [];
}


app.registerExtension({
  name: "KolidExtension",
  getNodeMenuItems(node) {
    const items = []
    items.push(
        {
            content: "CopyWidgets",
            callback: () => {
                window.MovingWidgets = node.widgets;
            }
        }
    )
    if(window.MovingWidgets.length > 0) {
        items.push(
        {
            content: "PasteWidgets",
            callback: () => {
                for (let index = 0; index < node.widgets.length; index++) {
                    const originalWidget = node.widgets[index];
                    const findWidget = window.MovingWidgets.find(w => w.name == originalWidget.name);
                    if(findWidget){
                        originalWidget.value = findWidget.value;
                    }
                } 
            }
        }
    )
    }
    items.push(
        {
            content: "CopyNodeId",
            callback: () => {
                navigator.clipboard.writeText(String(node.id));
            }
        }
    )
    items.push(
        {
            content: "CopyNodeName",
            callback: () => {
                navigator.clipboard.writeText(node.comfyClass || node.type);
            }
        }
    )
    return items
  }
})