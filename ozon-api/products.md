#  [](https://docs.ozon.ru/api/seller/en?__rr=1#section/Uploading-and-updating-products)Uploading and updating products
After comparing your attributes and characteristics with the Ozon attribute model, you can start uploading products:
  1. Upload products and services: [/v3/product/import](https://docs.ozon.ru/api/seller/en?__rr=1#operation/ProductAPI_ImportProductsV3). This method also allows you to update already uploaded products. The request sets the primary price and uploads product images. You can send up to 100 products in one request. Images should be uploaded as direct links to the cloud storage, where they are stored.
The method output is a `task_id`, the product upload task identifier.
  2. Check the `task_id` that you received while uploading products: [/v1/product/import/info](https://docs.ozon.ru/api/seller/en?__rr=1#operation/ProductAPI_GetImportProductsInfo). The method will return information whether the products were uploaded successfully or there was an error during import.
If the response contains the `moderating` status, wait for the moderation results and check the product status again. Moderation usually takes less than one day.
  3. Get a list of products created after uploading products: [/v3/product/list](https://docs.ozon.ru/api/seller/en?__rr=1#operation/ProductAPI_GetProductList).
The method allows you to use filters to divide products into groups by visibility status or track their status changes using the product identifier.
The method returns a pair of `offer_id` and `product_id` values. They are needed in almost all queries for identifying the product with which the action will be performed. If you have uploaded products via template, use this method to get the `offer_id` and `product_id` in order to work with products via API in the future.


##  [](https://docs.ozon.ru/api/seller/en?__rr=1#section/Uploading-and-updating-products/Uploading-and-updating-product-images)Uploading and updating product images
To add product images or replace existing ones, use:
  1. [/v1/product/pictures/import](https://docs.ozon.ru/api/seller/en?__rr=1#operation/ProductAPI_ProductImportPictures): upload or update product images. Pass direct links to images uploaded to the cloud storage.
  2. [/v2/product/pictures/info](https://docs.ozon.ru/api/seller/en?__rr=1#operation/ProductAPI_ProductInfoPicturesV2): check the uploading status.


##  [](https://docs.ozon.ru/api/seller/en?__rr=1#section/Uploading-and-updating-products/Updating-products)Updating products
To update both product information and its characteristics, use the [/v3/product/import](https://docs.ozon.ru/api/seller/en?__rr=1#operation/ProductAPI_ImportProductsV3) method.
If you only need to update the product characteristics, use the [/v1/product/attributes/update](https://docs.ozon.ru/api/seller/en?__rr=1#operation/ProductAPI_ProductUpdateAttributes) method.
##  [](https://docs.ozon.ru/api/seller/en?__rr=1#section/Uploading-and-updating-products/Getting-products-information)Getting products information
  * Get product details, for example barcode, main offer price, category identifier, commission, or moderation errors: [/v3/product/info/list](https://docs.ozon.ru/api/seller/en?__rr=1#operation/ProductAPI_GetProductInfoList). Use filters from the [/v3/product/list](https://docs.ozon.ru/api/seller/en?__rr=1#operation/ProductAPI_GetProductList) method to get a list for all products in bulk or by category.
  * Get a product characteristics description: [/v4/product/info/attributes](https://docs.ozon.ru/api/seller/en?__rr=1#operation/ProductAPI_GetProductAttributesV4). This method allows you to add extra information about the product to make the product card more complete.
  * Get a product description that can be used for creating a similar product: [/v1/product/info/description](https://docs.ozon.ru/api/seller/en?__rr=1#operation/ProductAPI_GetProductInfoDescription).
  * Get information about the markdown and the main product by the markdown product SKU: [/v1/product/info/discounted](https://docs.ozon.ru/api/seller/en?__rr=1#operation/ProductAPI_GetProductInfoDiscounted).


##  [](https://docs.ozon.ru/api/seller/en?__rr=1#section/Uploading-and-updating-products/Deleting-or-archiving-products)Deleting or archiving products
  1. Delete a product if it was uploaded with an error and got into the archive without an SKU: [/v2/products/delete](https://docs.ozon.ru/api/seller/en?__rr=1#operation/ProductAPI_DeleteProducts). Products that have successfully passed moderation and received an SKU cannot be deleted from the archive.
  2. Move a product into the archive: [/v1/product/archive](https://docs.ozon.ru/api/seller/en?__rr=1#operation/ProductAPI_ProductArchive). Reset the product stocks to zero before archiving it.
  3. Get a product back from the archive: [/v1/product/unarchive](https://docs.ozon.ru/api/seller/en?__rr=1#operation/ProductAPI_ProductUnarchive).


The product will go on sale only when you set its stocks.
##  [](https://docs.ozon.ru/api/seller/en?__rr=1#section/Uploading-and-updating-products/Services-management)Services management
Upload activation codes for services and digital products: [/v1/product/upload_digital_codes](https://docs.ozon.ru/api/seller/en?__rr=1#operation/ProductAPI_UploadDigitalCode).