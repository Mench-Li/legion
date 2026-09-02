#  [](https://docs.ozon.ru/api/seller/en?__rr=1#tag/CategoryAPI)Ozon attributes and characteristics
##  [](https://docs.ozon.ru/api/seller/en?__rr=1#operation/DescriptionCategoryAPI_GetTree)Tree of product category and type 
post
/v1/description-category/tree
  * Description and examples
  * Console


Returns product categories in the tree view. 
New products can be created in the last level categories only. This means that you need to match these particular categories with the categories of your site. We don't create new categories by user request.
##### header Parameters
Client-Id required  |  string Client ID.  
---|---  
Api-Key required  |  string API key.  
##### Request Body schema: application/json
language |  string Default:  "DEFAULT" Enum: "DEFAULT" "RU" "EN" "TR" "ZH_HANS" Response language:
  * `EN`—English,
  * `RU`—Russian,
  * `TR`—Turkish,
  * `ZH_HANS`—Chinese.

The default language is Russian.  
---|---  
### Responses
**200**
Category tree
##### Response Schema: application/json
result |  Array of objects Categories list.  
---|---  
Array () | description_category_id |  integer <int64> Category identifier.  
---|---  
category_name |  string Category name.  
children |  Array of objects Subcategory tree.  
disabled |  boolean `true`, if you can't create products in the category. `false`, if you can.  
type_id |  integer <int64> Product type identifier.  
type_name |  string Product type name.  
**default**
Error
### Request samples
  * Payload


Content type
application/json
`{
  *  "language": "DEFAULT" 

 }`
Copy
Collapse all
### Response samples
  * 200
  * default


Content type
application/json
`{
  *  "result": [
    *  { 
      *  "description_category_id": 0, 
 
      *  "category_name": "string", 
 
      *  "disabled": false, 
 
      *  "children": [
        *  { 
          *  "description_category_id": 0, 
 
          *  "category_name": "string", 
 
          *  "disabled": false, 
 
          *  "children": [
            *  { 
              *  "type_name": "sting", 
 
              *  "type_id": 0, 
 
              *  "disabled": false, 
 
              *  "children": [ ] 
  } 
 ] 
  } 
 ] 
  } 
 ] 

 }`
Copy
Collapse all
##  [](https://docs.ozon.ru/api/seller/en?__rr=1#operation/DescriptionCategoryAPI_GetAttributes)Category characteristics list 
post
/v1/description-category/attribute
  * Description and examples
  * Console


Getting characteristics for specified product category and type.
If the `dictionary_id` value is `0`, there is no directory. If the value is different, there are directories. Get them using the [/v1/description-category/attribute/values](https://docs.ozon.ru/api/seller/en?__rr=1#operation/DescriptionCategoryAPI_GetAttributeValues) method.
##### header Parameters
Client-Id required  |  string Client ID.  
---|---  
Api-Key required  |  string API key.  
##### Request Body schema: application/json
description_category_id required  |  integer <int64> Category identifier. You can get it using the [/v1/description-category/tree](https://docs.ozon.ru/api/seller/en?__rr=1#operation/DescriptionCategoryAPI_GetTree) method.  
---|---  
language |  string Default:  "DEFAULT" Enum: "DEFAULT" "RU" "EN" "TR" "ZH_HANS" Response language:
  * `EN`—English,
  * `RU`—Russian,
  * `TR`—Turkish,
  * `ZH_HANS`—Chinese.

The default language is Russian.  
type_id required  |  integer <int64> Product type identifier. You can get it using the [/v1/description-category/tree](https://docs.ozon.ru/api/seller/en?__rr=1#operation/DescriptionCategoryAPI_GetTree) method.  
### Responses
**200**
Category characteristics
##### Response Schema: application/json
result |  Array of objects Method result.  
---|---  
Array () | category_dependent |  boolean Indication that the dictionary attribute values depend on the category:
  * `true`—the attribute has its own set of values for each category.
  * `false`—the attribute has the same set of values for all categories.

  
---|---  
description |  string Characteristic description.  
dictionary_id |  integer <int64> Directory identifier.  
group_id |  integer <int64> Characteristics group identifier.  
group_name |  string Characteristics group name.  
id |  integer <int64> Characteristic identifier.  
is_aspect |  boolean Indicates that the attribute is aspect. An aspect attribute is a characteristic that distinguishes products of the same model. For example, clothes or shoes of the same model may have different colors and sizes. That is, color and size are aspect attributes. Values description:
  * `true`—the attribute is aspect and can't be changed after the products are delivered to the warehouse or sold from the seller's warehouse.
  * `false`—the attribute is not aspect and can be changed at any time.

  
is_collection |  boolean Indicates that the characteristic is a set of values:
  * `true`—the characteristic is a set of values,
  * `false`—the characteristic consists of a single value.

  
is_required |  boolean Indicates that the characteristic is mandatory:
  * `true`—a mandatory characteristic,
  * `false`—an optional characteristic.

  
name |  string Name.  
type |  string Characteristic type.  
attribute_complex_id |  integer <int64> Complex attribute identifier.  
max_value_count |  integer <int64> Maximum number of values for attribute.  
complex_is_collection |  boolean Indicates that the complex characteristic is a set of values:
  * `true`—the complex characteristic is a set of values,
  * `false`—the complex characteristic consists of a single value.

  
**default**
Error
### Request samples
  * Payload


Content type
application/json
`{
 
  *  "description_category_id": 0, 
 
  *  "language": "DEFAULT", 
 
  *  "type_id": 0 
 
 }`
Copy
Collapse all
### Response samples
  * 200
  * default


Content type
application/json
`{
  *  "result": [
    *  { 
      *  "category_dependent": true, 
 
      *  "description": "string", 
 
      *  "dictionary_id": 0, 
 
      *  "group_id": 0, 
 
      *  "group_name": "string", 
 
      *  "id": 0, 
 
      *  "is_aspect": true, 
 
      *  "is_collection": true, 
 
      *  "is_required": true, 
 
      *  "name": "string", 
 
      *  "type": "string", 
 
      *  "attribute_complex_id": 0, 
 
      *  "max_value_count": 0, 
 
      *  "complex_is_collection": true 
  } 
 ] 

 }`
Copy
Collapse all
##  [](https://docs.ozon.ru/api/seller/en?__rr=1#operation/DescriptionCategoryAPI_GetAttributeValues)Characteristics value directory 
post
/v1/description-category/attribute/values
  * Description and examples
  * Console


Returns characteristics value directory.
To check if an attribute has a nested directory, use the [/v1/description-category/attribute](https://docs.ozon.ru/api/seller/en?__rr=1#operation/DescriptionCategoryAPI_GetAttributes) method.
##### header Parameters
Client-Id required  |  string Client ID.  
---|---  
Api-Key required  |  string API key.  
##### Request Body schema: application/json
attribute_id required  |  integer <int64> Characteristics identifier. You can get it using the [/v1/description-category/attribute](https://docs.ozon.ru/api/seller/en?__rr=1#operation/DescriptionCategoryAPI_GetAttributes) method.  
---|---  
description_category_id required  |  integer <int64> Category identifier. You can get it using the [/v1/description-category/tree](https://docs.ozon.ru/api/seller/en?__rr=1#operation/DescriptionCategoryAPI_GetTree) method.  
language |  string Default:  "DEFAULT" Enum: "DEFAULT" "RU" "EN" "TR" "ZH_HANS" Response language:
  * `EN`—English,
  * `RU`—Russian,
  * `TR`—Turkish,
  * `ZH_HANS`—Chinese.

The default language is Russian.  
last_value_id |  integer <int64> Identifier of the directory to start the response with. If `last_value_id` is 10, the response will contain directories starting from the 11th.  
limit required  |  integer <int64> Number of values in the response:
  * maximum—2000,
  * minimum—1.

  
type_id required  |  integer <int64> Product type identifier. You can get it using the [/v1/description-category/tree](https://docs.ozon.ru/api/seller/en?__rr=1#operation/DescriptionCategoryAPI_GetTree) method.  
### Responses
**200**
Characteristics directory
##### Response Schema: application/json
has_next |  boolean Indication that only part of characteristic values was returned in the response:
  * `true`—make a request with a new `last_value_id` parameter value for getting the rest of characteristic values;
  * `false`—all characteristic values were returned.

  
---|---  
result |  Array of objects Characteristic values.  
Array () | id |  integer <int64> Characteristic value identifier.  
---|---  
info |  string Additional description.  
picture |  string Image link.  
value |  string Product characteristic value.  
**default**
Error
### Request samples
  * Payload


Content type
application/json
`{
 
  *  "attribute_id": 0, 
 
  *  "description_category_id": 0, 
 
  *  "language": "DEFAULT", 
 
  *  "last_value_id": 0, 
 
  *  "limit": 0, 
 
  *  "type_id": 0 
 
 }`
Copy
Collapse all
### Response samples
  * 200
  * default


Content type
application/json
`{
 
  *  "has_next": true, 
 
  *  "result": [
    *  { 
      *  "id": 0, 
 
      *  "info": "string", 
 
      *  "picture": "string", 
 
      *  "value": "string" 
  } 
 ] 
 
 }`
Copy
Collapse all
##  [](https://docs.ozon.ru/api/seller/en?__rr=1#operation/DescriptionCategoryAPI_SearchAttributeValues)Search by reference values of a characteristic 
post
/v1/description-category/attribute/values/search
  * Description and examples
  * Console


Returns characteristic reference values for the specified `value` in the request.
To check if an attribute has a nested directory, use the [/v1/description-category/attribute](https://docs.ozon.ru/api/seller/en?__rr=1#operation/DescriptionCategoryAPI_GetAttributes) method.
##### header Parameters
Client-Id required  |  string Client ID.  
---|---  
Api-Key required  |  string API key.  
##### Request Body schema: application/json
attribute_id required  |  integer <int64> Characteristic identifier. You can get it using the [/v1/description-category/attribute](https://docs.ozon.ru/api/seller/en?__rr=1#operation/DescriptionCategoryAPI_GetAttributes) method.  
---|---  
description_category_id required  |  integer <int64> Category identifier. You can get it using the [/v1/description-category/tree](https://docs.ozon.ru/api/seller/en?__rr=1#operation/DescriptionCategoryAPI_GetTree) method.  
limit required  |  integer <int64> Number of values in the response. The minimum value is 1, the maximum is 100.  
type_id required  |  integer <int64> Product type identifier. You can get it using the [/v1/description-category/tree](https://docs.ozon.ru/api/seller/en?__rr=1#operation/DescriptionCategoryAPI_GetTree) method.  
value required  |  string By this value the system searches for reference values. It must be at least 2 characters.  
### Responses
**200**
Reference values of a characteristic.
##### Response Schema: application/json
result |  Array of objects Characteristic values.  
---|---  
Array () | id |  integer <int64> Characteristic value identifier.  
---|---  
info |  string Additional information.  
picture |  string Image link.  
value |  string Product characteristic value.  
**default**
Error.
### Request samples
  * Payload


Content type
application/json
`{
 
  *  "attribute_id": 85, 
 
  *  "description_category_id": 17054869, 
 
  *  "limit": 100, 
 
  *  "type_id": 97311, 
 
  *  "value": "Name" 
 
 }`
Copy
Collapse all
### Response samples
  * 200
  * default


Content type
application/json
`{
  *  "result": [
    *  { 
      *  "id": 0, 
 
      *  "info": "string", 
 
      *  "picture": "string", 
 
      *  "value": "string" 
  } 
 ] 

 }`
Copy
Collapse all